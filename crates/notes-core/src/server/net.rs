use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::connect_info::Connected;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, Sleep};

pub(super) struct LimitedListener {
    listener: TcpListener,
    connections: Arc<Semaphore>,
}

impl LimitedListener {
    pub(super) fn new(listener: TcpListener) -> Self {
        Self {
            listener,
            connections: Arc::new(Semaphore::new(128)),
        }
    }
}

impl axum::serve::Listener for LimitedListener {
    type Io = Connection;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let mut reported_failure = false;
        loop {
            // Keep the permit until the socket closes, not merely until headers arrive.
            let permit = self
                .connections
                .clone()
                .acquire_owned()
                .await
                .expect("the private connection semaphore is never closed");
            match self.listener.accept().await {
                Ok((stream, address)) => {
                    if let Err(error) = stream.set_nodelay(true) {
                        eprintln!("Could not disable local connection buffering: {error}");
                    }
                    return (
                        Connection {
                            stream,
                            _permit: permit,
                            deadline: Box::pin(tokio::time::sleep(Duration::from_secs(30))),
                            control: ConnectionInfo(Arc::new(Mutex::new(Some(
                                Instant::now() + Duration::from_secs(30),
                            )))),
                        },
                        address,
                    );
                }
                Err(error) => {
                    if !reported_failure {
                        eprintln!("Could not accept a local connection; retrying: {error}");
                        reported_failure = true;
                    }
                    drop(permit);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

pub(super) struct Connection {
    stream: TcpStream,
    _permit: OwnedSemaphorePermit,
    // A hard lifetime also bounds a client that slowly drips incomplete headers.
    deadline: Pin<Box<Sleep>>,
    control: ConnectionInfo,
}

#[derive(Clone)]
pub(super) struct ConnectionInfo(Arc<Mutex<Option<Instant>>>);

impl<'a> Connected<axum::serve::IncomingStream<'a, LimitedListener>> for ConnectionInfo {
    fn connect_info(stream: axum::serve::IncomingStream<'a, LimitedListener>) -> Self {
        stream.io().control.clone()
    }
}

impl ConnectionInfo {
    pub(super) fn allow_request(&self, timeout: Duration) {
        if let Ok(mut deadline) = self.0.lock() {
            *deadline = Some(Instant::now() + timeout);
        } else {
            eprintln!("Could not extend connection deadline: lock poisoned.");
        }
    }

    pub(super) fn websocket(&self) {
        if let Ok(mut deadline) = self.0.lock() {
            *deadline = None;
        } else {
            eprintln!("Could not activate WebSocket: deadline lock poisoned.");
        }
    }
}

impl Connection {
    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        let deadline = match self.control.0.lock() {
            Ok(deadline) => *deadline,
            Err(_) => return true,
        };
        let Some(deadline) = deadline else {
            return false;
        };
        if self.deadline.deadline() != deadline {
            self.deadline.as_mut().reset(deadline);
        }
        self.deadline.as_mut().poll(cx).is_ready()
    }
}

impl AsyncRead for Connection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for Connection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
