use std::{
    ffi::OsStr,
    io::{self, Read},
    path::Path,
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct Output {
    pub(super) status: ExitStatus,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

struct Captured {
    bytes: Vec<u8>,
    exceeded: bool,
}

pub(super) enum Error {
    Unavailable,
    Timeout,
    TooLarge,
    Io(String),
    Failed(Output),
}

pub(super) fn run<I, S>(
    root: &Path,
    arguments: I,
    write: bool,
    remote: Option<&super::Remote>,
    cloning: bool,
) -> Result<Output, Error>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_checked(root, arguments, write, remote, cloning, &|| Ok(()))
}

pub(super) fn run_checked<I, S>(
    root: &Path,
    arguments: I,
    write: bool,
    remote: Option<&super::Remote>,
    cloning: bool,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Output, Error>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    check().map_err(Error::Io)?;
    let mut command = Command::new("git");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .arg("-C")
        .arg(root)
        .args(["-c", hook_setting()])
        .args(["-c", "core.fsmonitor=false"])
        .args(["-c", "core.pager=cat"])
        .args(["-c", "color.ui=false"])
        .args(["-c", "protocol.allow=never"])
        .args(["-c", "protocol.file.allow=always"])
        .args(["-c", "protocol.http.allow=always"])
        .args(["-c", "protocol.https.allow=always"])
        .args(["-c", "protocol.ssh.allow=always"])
        .args(["-c", "protocol.ext.allow=never"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C");
    if !write {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_NAMESPACE",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_TRACE",
        "GIT_TRACE_CURL",
        "GIT_TRACE_PACKET",
        "GIT_CURL_VERBOSE",
    ] {
        command.env_remove(name);
    }
    if let Some(remote) = remote {
        use base64::Engine;
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_ATTR_NOSYSTEM", "1");
        command.args([
            "-c",
            "protocol.file.allow=never",
            "-c",
            "protocol.http.allow=never",
            "-c",
            "protocol.ssh.allow=never",
        ]);
        let mut settings = vec![
            ("credential.helper", String::new()),
            ("http.followRedirects", "false".into()),
            ("protocol.file.allow", "never".into()),
            ("protocol.http.allow", "never".into()),
            ("protocol.ssh.allow", "never".into()),
        ];
        if !cloning {
            settings.push(("remote.origin.url", remote.url.clone()));
            settings.push(("remote.origin.pushurl", remote.url.clone()));
        }
        if let Some(token) = &remote.token {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
            settings.push((
                "http.https://github.com/.extraHeader",
                format!("Authorization: Basic {encoded}"),
            ));
        }
        // Environment config avoids putting credentials in URLs, .git/config or argv.
        command.env("GIT_CONFIG_COUNT", settings.len().to_string());
        for (index, (key, value)) in settings.into_iter().enumerate() {
            command
                .env(format!("GIT_CONFIG_KEY_{index}"), key)
                .env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
    }
    command.args(arguments);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            Error::Unavailable
        } else {
            Error::Io(error.to_string())
        }
    })?;
    let stdout = capture(
        child
            .stdout
            .take()
            .ok_or_else(|| Error::Io("Git stdout is unavailable.".into()))?,
    );
    let stderr = capture(
        child
            .stderr
            .take()
            .ok_or_else(|| Error::Io("Git stderr is unavailable.".into()))?,
    );
    let deadline = Instant::now()
        + if cloning {
            Duration::from_secs(120)
        } else {
            COMMAND_TIMEOUT
        };
    let mut next_check = Instant::now();
    let status = loop {
        if Instant::now() >= next_check {
            if let Err(error) = check() {
                terminate(&mut child);
                let _ = stdout.join();
                let _ = stderr.join();
                return Err(Error::Io(error));
            }
            next_check = Instant::now() + Duration::from_millis(100);
        }
        match child
            .try_wait()
            .map_err(|error| Error::Io(error.to_string()))?
        {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            None => {
                terminate(&mut child);
                let _ = stdout.join();
                let _ = stderr.join();
                return Err(Error::Timeout);
            }
        }
    };
    let stdout = stdout
        .join()
        .map_err(|_| Error::Io("Git stdout reader failed.".into()))?
        .map_err(|error| Error::Io(error.to_string()))?;
    let stderr = stderr
        .join()
        .map_err(|_| Error::Io("Git stderr reader failed.".into()))?
        .map_err(|error| Error::Io(error.to_string()))?;
    if stdout.exceeded || stderr.exceeded {
        return Err(Error::TooLarge);
    }
    Ok(Output {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // Each Git child owns the process group created above, including transport children.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn capture(mut reader: impl Read + Send + 'static) -> thread::JoinHandle<io::Result<Captured>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut exceeded = false;
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            if bytes.len() < MAX_OUTPUT_BYTES {
                let keep = read.min(MAX_OUTPUT_BYTES - bytes.len());
                bytes.extend_from_slice(&buffer[..keep]);
                exceeded |= keep < read;
            } else {
                exceeded = true;
            }
        }
        Ok(Captured { bytes, exceeded })
    })
}

fn hook_setting() -> &'static str {
    if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    }
}
