use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use notes_core::{
    auth::{Role, UserStore},
    server::{RunningServer, start, start_with_users},
    settings::{DefaultView, SettingsStore},
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};

struct Workspace {
    base: PathBuf,
    root: PathBuf,
    outside: PathBuf,
}

impl Workspace {
    fn new() -> Self {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        // Keep disposable fixtures in the checkout, never in a user's notes or OS temp folder.
        let base = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("server-tests")
            .join(name);
        let root = base.join("notes");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        Self {
            base,
            root,
            outside,
        }
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.base) {
            eprintln!(
                "Could not clean backend test fixture {}: {error}",
                self.base.display()
            );
        }
    }
}

#[derive(Clone)]
struct Client {
    port: u16,
    token: String,
}

impl Client {
    fn new(server: &RunningServer) -> Self {
        Self {
            port: server.port(),
            token: server
                .url()
                .split_once("#token=")
                .map(|(_, token)| token.to_owned())
                .unwrap_or_default(),
        }
    }

    fn request(&self, method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
        let mut stream = TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port).into(),
            Duration::from_secs(2),
        )
        .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "{method} {target} HTTP/1.1\r\nConnection: close\r\n"
        )
        .unwrap();
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        {
            write!(stream, "Host: 127.0.0.1:{}\r\n", self.port).unwrap();
        }
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        {
            write!(stream, "Content-Length: {}\r\n", body.len()).unwrap();
        }
        for (name, value) in headers {
            write!(stream, "{name}: {value}\r\n").unwrap();
        }
        stream.write_all(b"\r\n").unwrap();
        stream.write_all(body).unwrap();
        stream.flush().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        Reply::parse(&bytes)
    }

    fn api(&self, method: &str, target: &str, body: Option<Value>) -> Reply {
        let body = body
            .map(|value| serde_json::to_vec(&value).unwrap())
            .unwrap_or_default();
        self.request(
            method,
            target,
            &[
                ("Authorization", &format!("Bearer {}", self.token)),
                ("Content-Type", "application/json"),
            ],
            &body,
        )
    }

    fn session_cookie(&self) -> String {
        let reply = self.api("POST", "/api/session", None);
        assert_eq!(reply.status, 200, "{}", reply.text());
        let cookie = &reply.headers["set-cookie"];
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Path=/assets"));
        assert!(cookie.starts_with(&format!("notes_session_{}=", self.port)));
        assert_eq!(reply.json()["port"], self.port);
        cookie.split(';').next().unwrap().to_owned()
    }

    fn get_document(&self, path: &str) -> Reply {
        let resource = self.resolve_resource(path, "document");
        if resource.status != 200 {
            return resource;
        }
        self.api(
            "GET",
            &format!(
                "/api/document?id={}",
                resource.json()["id"].as_str().unwrap()
            ),
            None,
        )
    }

    fn resolve_resource(&self, path: &str, kind: &str) -> Reply {
        self.api(
            "POST",
            "/api/resources/resolve",
            Some(json!({"path":path,"kind":kind})),
        )
    }

    fn resource_id(&self, path: &str, kind: &str) -> String {
        let resource = self.resolve_resource(path, kind);
        assert_eq!(resource.status, 200, "{}", resource.text());
        resource.json()["id"].as_str().unwrap().into()
    }
}

struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Reply {
    fn parse(bytes: &[u8]) -> Self {
        let split = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("invalid HTTP response: {}", String::from_utf8_lossy(bytes)));
        let head = std::str::from_utf8(&bytes[..split]).unwrap();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .map(|line| {
                let (name, value) = line.split_once(':').unwrap();
                (name.to_ascii_lowercase(), value.trim().to_owned())
            })
            .collect::<HashMap<_, _>>();
        let body = if headers
            .get("transfer-encoding")
            .is_some_and(|value| value == "chunked")
        {
            let mut remaining = &bytes[split + 4..];
            let mut body = Vec::new();
            loop {
                let line_end = remaining
                    .windows(2)
                    .position(|part| part == b"\r\n")
                    .unwrap();
                let length = usize::from_str_radix(
                    std::str::from_utf8(&remaining[..line_end])
                        .unwrap()
                        .split(';')
                        .next()
                        .unwrap(),
                    16,
                )
                .unwrap();
                remaining = &remaining[line_end + 2..];
                if length == 0 {
                    break;
                }
                body.extend_from_slice(&remaining[..length]);
                remaining = &remaining[length + 2..];
            }
            body
        } else {
            bytes[split + 4..].to_vec()
        };
        Self {
            status,
            headers,
            body,
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|error| {
            panic!(
                "invalid JSON: {error}; status {}; {}",
                self.status,
                self.text()
            )
        })
    }

    fn error(&self, status: u16) {
        assert_eq!(self.status, status, "{}", self.text());
        assert!(
            self.json()["error"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
        );
        assert_eq!(self.headers["x-content-type-options"], "nosniff");
        assert_eq!(self.headers["cache-control"], "no-store");
    }
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

#[path = "server/accounts.rs"]
mod accounts;
#[path = "server/attachments.rs"]
mod attachments;
#[path = "server/binding.rs"]
mod binding;
#[path = "server/collaboration.rs"]
mod collaboration;
#[path = "server/documents.rs"]
mod documents;
#[path = "server/git.rs"]
mod git;
#[path = "server/git_sync.rs"]
mod git_sync;
#[path = "server/history.rs"]
mod history;
#[path = "server/identities.rs"]
mod identities;
#[path = "server/projects.rs"]
mod projects;
#[path = "server/public_expiry.rs"]
mod public_expiry;
#[path = "server/public_options.rs"]
mod public_options;
#[path = "server/public_sharing.rs"]
mod public_sharing;
#[path = "server/refactor.rs"]
mod refactor;
#[path = "server/resource_fixture.rs"]
mod resource_fixture;
#[path = "server/retention.rs"]
mod retention;
#[path = "server/runtime.rs"]
mod runtime;
#[path = "server/search.rs"]
mod search;
#[path = "server/security.rs"]
mod security;
#[path = "server/sessions.rs"]
mod sessions;
