use super::{ApiError, Output, RunError, Service, process};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::server) struct Target {
    pub branch: String,
    pub remote: String,
    pub merge: String,
    destination: String,
}

impl Service {
    fn sync_command<I, S>(
        &self,
        args: I,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Output, ApiError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let remote = self
            .remote
            .lock()
            .map_err(|_| ApiError::internal("Git credentials are unavailable."))?
            .clone();
        let output = process::run_checked(&self.root, args, true, remote.as_ref(), false, check)
            .map_err(|error| self.api_error(error))?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(self.api_error(RunError::Failed(output)))
        }
    }

    fn sync_text(
        &self,
        args: &[&str],
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<String, ApiError> {
        String::from_utf8(self.sync_command(args, check)?.stdout)
            .map(|text| text.trim().to_owned())
            .map_err(|_| ApiError::bad_request("Git configuration must be valid Unicode."))
    }

    pub(in crate::server) fn sync_target(
        &self,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Target, ApiError> {
        self.require_repository()?;
        let branch = self.sync_text(&["symbolic-ref", "--quiet", "HEAD"], check)?;
        let name = branch.strip_prefix("refs/heads/").ok_or_else(|| {
            ApiError::bad_request("Select a local branch before enabling automatic Git sync.")
        })?;
        let remote = self
            .sync_text(
                &["config", "--get", &format!("branch.{name}.remote")],
                check,
            )
            .map_err(|error| {
                ApiError::bad_request(format!(
                    "Set a branch upstream before enabling automatic Git sync. {}",
                    error.message
                ))
            })?;
        let merge = self.sync_text(&["config", "--get", &format!("branch.{name}.merge")], check)?;
        if remote.is_empty()
            || remote == "."
            || remote.starts_with('-')
            || !merge.starts_with("refs/heads/")
        {
            return Err(ApiError::bad_request(
                "Automatic Git sync needs a remote branch upstream.",
            ));
        }
        let urls = self.sync_text(&["remote", "get-url", "--push", "--all", &remote], check)?;
        if urls.lines().count() != 1 || urls.is_empty() {
            return Err(ApiError::bad_request(
                "Automatic Git sync requires exactly one push destination.",
            ));
        }
        Ok(Target {
            branch,
            remote,
            merge,
            destination: crate::server::hex(&Sha256::digest(urls.as_bytes())),
        })
    }

    pub(in crate::server) fn sync_lock_path(&self) -> Result<std::path::PathBuf, ApiError> {
        self.require_repository()?;
        let directory = self.sync_text(&["rev-parse", "--git-common-dir"], &|| Ok(()))?;
        Ok(self.root.join(directory).join("notes-auto-sync.lock"))
    }

    fn ensure_sync_target(
        &self,
        target: &Target,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), ApiError> {
        if self.sync_target(check)? != *target {
            return Err(ApiError::conflict(
                "Git branch, upstream or push destination changed. Disable and re-enable automatic sync to approve the new target.",
            ));
        }
        for marker in [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge",
            "rebase-apply",
            "BISECT_START",
            "sequencer",
        ] {
            let path = self.sync_text(&["rev-parse", "--git-path", marker], check)?;
            if self
                .root
                .join(path)
                .try_exists()
                .map_err(|error| ApiError::io("Could not inspect Git operation", error))?
            {
                return Err(ApiError::conflict(
                    "Finish the in-progress Git merge, rebase or other operation before automatic sync.",
                ));
            }
        }
        if !self
            .sync_command(["ls-files", "--unmerged", "-z"], check)?
            .stdout
            .is_empty()
        {
            return Err(ApiError::conflict(
                "Resolve Git conflicts before automatic sync.",
            ));
        }
        Ok(())
    }

    pub(in crate::server) fn automatic_sync(
        &self,
        saves: &std::sync::Mutex<()>,
        target: &Target,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), ApiError> {
        // Match manual Git's save -> Git lock order; release the save lock before network I/O.
        let saving = saves.try_lock().map_err(|_| {
            ApiError::conflict(
                "Project writes are active. Automatic Git sync will retry at the next interval.",
            )
        })?;
        let _write = self
            .write_lock
            .try_lock()
            .map_err(|_| ApiError::conflict("Another Git operation is active. Automatic Git sync will retry at the next interval."))?;
        self.ensure_sync_target(target, check)?;
        self.sync_command(["var", "GIT_AUTHOR_IDENT"], check)?;
        self.sync_command(["var", "GIT_COMMITTER_IDENT"], check)?;
        self.sync_command(["add", "--all", "--", "."], check)?;
        if !self
            .sync_command(
                [
                    "diff",
                    "--cached",
                    "--name-only",
                    "-z",
                    "--no-ext-diff",
                    "--no-textconv",
                ],
                check,
            )?
            .stdout
            .is_empty()
        {
            self.sync_command(
                [
                    "-c",
                    "commit.gpgSign=false",
                    "commit",
                    "--no-verify",
                    "-m",
                    "Notes: automatic sync",
                ],
                check,
            )?;
        }
        drop(saving);
        self.ensure_sync_target(target, check)?;
        self.sync_command(
            [
                "-c",
                &format!("remote.{}.mirror=false", target.remote),
                "-c",
                "push.followTags=false",
                "-c",
                "push.gpgSign=false",
                "push",
                "--no-force",
                "--no-follow-tags",
                "--recurse-submodules=no",
                "--",
                &target.remote,
                &format!("{}:{}", target.branch, target.merge),
            ],
            check,
        )?;
        Ok(())
    }
}
