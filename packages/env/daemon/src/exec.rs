//! `exec`: Durable's `NodeExecutionEnv.exec` semantics (docs/semantics.md), output streamed as `output` events; and what
//! the commands of `exec`, `pty` and `process` share: cancellation, starting, reading pipes and reaping.

use crate::decode::StreamDecoder;
use crate::errors::Failure;
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use crate::sys;
use crate::window::{Pending, Window};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);
/// How often a delivery waiting for the link to drain looks again.
const UNSENT_POLL: Duration = Duration::from_millis(20);

/// Commands this daemon started and has not reaped; killed when the connection ends.
pub type Groups = Arc<Mutex<HashSet<u32>>>;

pub enum Message {
    Data(usize, Vec<u8>),
    Eof(usize),
    Exit(ExitStatus),
    WaitFailed(String),
    /// Abort: the command settles as `aborted`.
    Cancel,
    /// Kill without aborting, as `cleanup()` does: the command settles with the killed process's status.
    Kill,
}

/// Cancellation of one request, registered before the request runs so a cancel that arrives first is not lost.
#[derive(Default)]
pub struct Control {
    pub aborted: AtomicBool,
    pub killed: AtomicBool,
    sender: Mutex<Option<Sender<Message>>>,
}

impl Control {
    pub fn cancel(&self, kill: bool) {
        let sender = self.sender.lock().unwrap();
        if kill {
            self.killed.store(true, Ordering::SeqCst);
        } else {
            self.aborted.store(true, Ordering::SeqCst);
        }
        if let Some(sender) = sender.as_ref() {
            let _ = sender.send(if kill { Message::Kill } else { Message::Cancel });
        }
    }

    pub fn attach(&self, sender: Sender<Message>) {
        *self.sender.lock().unwrap() = Some(sender);
    }
}

pub struct ExecRequest {
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub cwd: String,
    pub env: Map<String, Value>,
    pub inherit_env: bool,
    pub shell_path: Option<String>,
    pub timeout: Option<Duration>,
    pub spill: Option<(u64, u64)>,
    pub window: Option<Window>,
}

impl ExecRequest {
    pub fn from_json(json: &Value) -> Result<ExecRequest, Failure> {
        let strings = |value: &Value| -> Option<Vec<String>> {
            value
                .as_array()?
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect()
        };
        Ok(ExecRequest {
            command: json["command"].as_str().map(str::to_string),
            argv: strings(&json["argv"]),
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "exec needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            shell_path: json["shellPath"].as_str().map(str::to_string),
            timeout: json["timeoutMs"]
                .as_f64()
                .map(|ms| Duration::from_secs_f64(ms / 1000.0)),
            spill: json["spill"].as_object().and_then(|spill| {
                Some((
                    spill.get("afterBytes")?.as_u64()?,
                    spill.get("afterLines")?.as_u64()?,
                ))
            }),
            window: Window::from_json(&json["window"]),
        })
    }
}

pub fn kill_group(pid: u32) {
    sys::kill_tree(pid);
}

fn random_uuid() -> String {
    let mut bytes = sys::random_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Spill of the complete raw output, started once it crosses either threshold, like Node's.
struct Spill {
    after_bytes: u64,
    after_lines: u64,
    seen_bytes: u64,
    seen_newlines: u64,
    prefix: Vec<Vec<u8>>,
    file: Option<File>,
    path: Option<String>,
    failed: Option<String>,
}

impl Spill {
    fn push(&mut self, chunk: &[u8], tmpdir: &str) {
        if self.failed.is_some() || chunk.is_empty() {
            return;
        }
        if self.file.is_none() {
            self.seen_bytes += chunk.len() as u64;
            self.seen_newlines += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
            let lines = self.seen_newlines + u64::from(chunk.last() != Some(&b'\n'));
            if self.seen_bytes <= self.after_bytes && lines <= self.after_lines {
                self.prefix.push(chunk.to_vec());
                return;
            }
            if let Err(error) = self.start(tmpdir) {
                self.failed = Some(error);
                return;
            }
        }
        if let Some(file) = &mut self.file
            && let Err(error) = file.write_all(chunk)
        {
            self.failed = Some(error.to_string());
        }
    }

    /// `createTempFile({ prefix: "pi-output-", suffix: ".log" })`: a fresh `tmp-` directory holding the file.
    fn start(&mut self, tmpdir: &str) -> Result<(), String> {
        let prefix = Path::new(tmpdir)
            .join("tmp-")
            .to_string_lossy()
            .into_owned();
        let directory = sys::mkdtemp(&prefix).map_err(|error| error.to_string())?;
        let path = Path::new(&directory)
            .join(format!("pi-output-{}.log", random_uuid()))
            .to_string_lossy()
            .into_owned();
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        for chunk in self.prefix.drain(..) {
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        self.file = Some(file);
        self.path = Some(path);
        Ok(())
    }
}

/// Where and with which environment a program starts.
pub struct Launch<'a> {
    pub cwd: &'a str,
    pub env: &'a Map<String, Value>,
    pub inherit_env: bool,
}

/// Start `program` with piped stdout and stderr, in a process group of its own, as libuv starts commands.
pub fn spawn(
    program: &str,
    args: &[String],
    launch: &Launch,
    stdin: Stdio,
) -> std::io::Result<Child> {
    let mut command = Command::new(program);
    command
        .current_dir(launch.cwd)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::configure(&mut command, args, launch.env, launch.inherit_env);
    let child = command.spawn()?;
    sys::after_spawn(&child);
    Ok(child)
}

/// A `process` program's group, killed once the program exits, and the daemon's groups, which forget the program
/// before it is reaped.
pub struct Ending {
    pub group: sys::Group,
    pub groups: Groups,
}

/// Reap `child` on a thread of its own, which sends its exit to `sender`. With `ending`, what the child started in its
/// group is killed once it exits, before the exit is sent. A thread that cannot start hands the child back with the
/// error, so the caller kills and reaps it.
pub fn start_waiter(
    child: Child,
    ending: Option<Ending>,
    sender: Sender<Message>,
) -> Result<(), (Child, std::io::Error)> {
    // The waiter receives the child once it runs, so a waiter that cannot start leaves the child here to reap.
    let (give, take) = mpsc::channel::<Child>();
    let started = thread::Builder::new().spawn(move || {
        let Ok(mut child) = take.recv() else {
            return;
        };
        let status = match &ending {
            None => child.wait(),
            Some(ending) => {
                // After a failed wait, ending the group kills the program, so the reap below still returns.
                let exited = ending.group.wait_for_exit(&mut child);
                ending.group.end();
                // Forgotten before it is reaped: a kill that checks `groups` under its lock never reaches a reused pid.
                ending.groups.lock().unwrap().remove(&child.id());
                exited.and(child.wait())
            }
        };
        let _ = sender.send(match status {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    match started {
        Ok(_) => {
            let _ = give.send(child);
            Ok(())
        }
        Err(error) => Err((child, error)),
    }
}

/// The `argv` of a request: `None` when absent, else a non-empty array of strings.
pub fn argv(json: &Value) -> Result<Option<Vec<String>>, Failure> {
    match &json["argv"] {
        Value::Null => Ok(None),
        value => value
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect::<Option<Vec<String>>>()
            })
            .filter(|argv| !argv.is_empty())
            .map(Some)
            .ok_or_else(|| Failure::new("EINVAL", "argv must be a non-empty array of strings")),
    }
}

/// The running request a follow-up request names in `target` (`ptyWrite`, `processWrite`, ...); `what` names its kind
/// in the error.
pub fn running<T>(
    requests: &Mutex<HashMap<u32, Arc<T>>>,
    json: &Value,
    what: &str,
) -> Result<Arc<T>, Failure> {
    let target = json["target"]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", "missing field target"))?;
    requests
        .lock()
        .unwrap()
        .get(&(target as u32))
        .cloned()
        .ok_or_else(|| Failure::new("EBADF", format!("no running {what} with this id")))
}

/// Tells one request's loop whether its readers are held back by an unsent backlog. Such a reader is silent because
/// of the link, not the program, so the exit grace must not run out on it (the pipe may still hold output).
#[derive(Default)]
pub struct Throttle {
    waiting: AtomicUsize,
    /// Counts the waits that ended, so a reader that was just released, and has not sent yet, still counts.
    releases: AtomicUsize,
}

impl Throttle {
    /// `Output::wait_for_room`, visible to the request's loop.
    pub fn wait_for_room(&self, output: &Output, stop: &AtomicBool) {
        self.waiting.fetch_add(1, Ordering::SeqCst);
        if output.wait_for_room(stop) {
            self.releases.fetch_add(1, Ordering::SeqCst);
        }
        self.waiting.fetch_sub(1, Ordering::SeqCst);
    }

    /// Whether a reader waits now or stopped waiting since the previous call, which `seen` remembers.
    fn active(&self, seen: &mut usize) -> bool {
        let releases = self.releases.load(Ordering::SeqCst);
        let released = releases != *seen;
        *seen = releases;
        released || self.waiting.load(Ordering::SeqCst) > 0
    }
}

/// The next message for a loop that stops waiting once `idle_until` has passed without any. Messages already queued
/// are always taken first; an expired grace is renewed while a reader is throttled, unless `forced` (killed, aborted
/// or timed out). `None` means the grace is over. `wait` bounds the wait before the grace expires.
pub fn receive(
    receiver: &Receiver<Message>,
    wait: Duration,
    idle_until: &mut Option<Instant>,
    throttle: &Throttle,
    seen: &mut usize,
    forced: bool,
    grace: Duration,
) -> Option<Result<Message, RecvTimeoutError>> {
    let now = Instant::now();
    if idle_until.is_none_or(|idle| now < idle) {
        return Some(receiver.recv_timeout(wait));
    }
    match receiver.try_recv() {
        Ok(message) => return Some(Ok(message)),
        Err(TryRecvError::Disconnected) => return Some(Err(RecvTimeoutError::Disconnected)),
        Err(TryRecvError::Empty) => {}
    }
    if forced || !throttle.active(seen) {
        return None;
    }
    *idle_until = Some(now + grace);
    Some(receiver.recv_timeout(grace))
}

/// Read one pipe on its own thread until it ends or `stop` is set. With a gate, reading waits while too much output
/// is unsent.
pub fn spawn_reader(
    stream: usize,
    pipe: impl sys::Pipe + Send + 'static,
    sender: Sender<Message>,
    stop: Arc<AtomicBool>,
    gate: Option<(Arc<Output>, Arc<Throttle>)>,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new().spawn(move || {
        sys::read_pipe(pipe, &stop, |bytes| {
            let delivered = sender.send(Message::Data(stream, bytes.to_vec())).is_ok();
            if let Some((output, throttle)) = &gate {
                throttle.wait_for_room(output, &stop);
            }
            delivered
        });
        let _ = sender.send(Message::Eof(stream));
    })
}

fn output_frame(id: u32, stream: &str, text: String, skipped: Option<Value>) -> Frame {
    let mut json = json!({ "kind": "output", "stream": stream });
    if let Some(skipped) = skipped {
        json["skipped"] = skipped;
    }
    Frame::with_payload(EVENT, id, json, text.into_bytes())
}

/// Run one command, sending output events for request `id`, until it settles.
pub fn run(
    id: u32,
    request: ExecRequest,
    tmpdir: &str,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
) -> Result<Value, Failure> {
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    // A string runs through the shell (as its last argument, or on stdin for legacy WSL bash); argv runs directly.
    let (program, args, stdin_command) = match (&request.command, &request.argv) {
        (Some(command), _) => {
            let shell = sys::shell_config(request.shell_path.as_deref())?;
            let mut args = shell.args;
            if shell.command_on_stdin {
                (shell.program, args, Some(command.clone()))
            } else {
                args.push(command.clone());
                (shell.program, args, None)
            }
        }
        (None, Some(argv)) => match argv.split_first() {
            Some((first, rest)) => (
                sys::resolve_program(first, &request.cwd, &request.env)?,
                rest.to_vec(),
                None,
            ),
            None => return Err(Failure::new("spawn_error", "Empty argv: no program to run")),
        },
        (None, None) => return Err(Failure::new("EINVAL", "exec needs command or argv")),
    };
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!(
                "Working directory does not exist: {}\nCannot execute bash commands.",
                request.cwd
            ),
        ));
    }
    let launch = Launch {
        cwd: &request.cwd,
        env: &request.env,
        inherit_env: request.inherit_env,
    };
    let stdin = if stdin_command.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    let mut child = spawn(&program, &args, &launch, stdin)
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    if let (Some(command), Some(mut stdin)) = (stdin_command, child.stdin.take()) {
        let _ = stdin.write_all(command.as_bytes());
    }
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let deadline = request.timeout.map(|timeout| Instant::now() + timeout);
    let stop = Arc::new(AtomicBool::new(false));
    // Without a window, output is not coalesced; reading then waits for the link.
    let throttle = Arc::new(Throttle::default());
    let gate = if request.window.is_none() {
        Some((output.clone(), throttle.clone()))
    } else {
        None
    };
    // A thread that cannot start (a task limit) fails the command; the started child is killed and reaped. Readers
    // already running see `stop` within 100 ms.
    let abandon = |mut child: Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        // On Windows the group kill spawns taskkill, which can fail under the same limit; kill the child directly.
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    let stdout = child.stdout.take().unwrap();
    if let Err(error) = spawn_reader(0, stdout, sender.clone(), stop.clone(), gate.clone()) {
        return Err(abandon(child, error));
    }
    let stderr = child.stderr.take().unwrap();
    if let Err(error) = spawn_reader(1, stderr, sender.clone(), stop.clone(), gate) {
        return Err(abandon(child, error));
    }
    if let Err((child, error)) = start_waiter(child, None, sender.clone()) {
        return Err(abandon(child, error));
    }
    drop(sender);

    let mut decoders = [StreamDecoder::new(), StreamDecoder::new()];
    let mut spill = request.spill.map(|(after_bytes, after_lines)| Spill {
        after_bytes,
        after_lines,
        seen_bytes: 0,
        seen_newlines: 0,
        prefix: Vec::new(),
        file: None,
        path: None,
        failed: None,
    });
    let mut pending = request.window.map(Pending::new);
    let unsent = Arc::new(AtomicUsize::new(0));
    let names = ["stdout", "stderr"];
    let emit = |pending: &mut Option<Pending>, stream: usize, text: String| {
        if text.is_empty() {
            return;
        }
        match pending {
            Some(pending) => pending.push(names[stream], text),
            None => output.bulk(output_frame(id, names[stream], text, None), None),
        }
    };
    let deliver = |pending: &mut Pending| {
        for event in pending.take() {
            output.bulk(
                output_frame(id, event.stream, event.text, event.skipped),
                Some(unsent.clone()),
            );
        }
    };
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
    let mut seen_releases = 0;
    let mut timed_out = false;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        let now = Instant::now();
        // Node's timer stays armed until the command settles, including the grace period after exit.
        if !timed_out && deadline.is_some_and(|deadline| now >= deadline) {
            timed_out = true;
            kill(&mut killed);
        }
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        if let Some(pending) = &mut pending
            && !pending.is_empty()
            && now >= pending.next_send()
            && unsent.load(Ordering::SeqCst) == 0
        {
            deliver(pending);
        }
        let mut wait = Duration::from_secs(3600);
        if let Some(deadline) = deadline.filter(|_| !timed_out) {
            wait = wait.min(deadline.saturating_duration_since(now));
        }
        if let Some(idle) = idle_until {
            wait = wait.min(idle.saturating_duration_since(now));
        }
        if let Some(pending) = pending.as_ref().filter(|pending| !pending.is_empty()) {
            wait = wait.min(if unsent.load(Ordering::SeqCst) > 0 {
                UNSENT_POLL
            } else {
                pending.next_send().saturating_duration_since(now)
            });
        }
        // A descendant may hold the pipes open after the process exited; `receive` ends the wait for it.
        let Some(message) = receive(
            &receiver,
            wait,
            &mut idle_until,
            &throttle,
            &mut seen_releases,
            killed,
            EXIT_STDIO_GRACE,
        ) else {
            break;
        };
        match message {
            Ok(Message::Data(stream, bytes)) => {
                emit(&mut pending, stream, decoders[stream].decode(&bytes, false));
                if let Some(spill) = &mut spill {
                    spill.push(&bytes, tmpdir);
                    if spill.failed.is_some() {
                        kill(&mut killed);
                    }
                }
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Like Node destroying its streams: readers stop within 100 ms, so the pipes close even if a descendant still holds
    // them.
    stop.store(true, Ordering::SeqCst);
    groups.lock().unwrap().remove(&pid);
    emit(&mut pending, 0, decoders[0].decode(&[], true));
    emit(&mut pending, 1, decoders[1].decode(&[], true));
    if let Some(pending) = &mut pending
        && !pending.is_empty()
    {
        deliver(pending);
    }
    let spill_path = spill.as_ref().and_then(|spill| spill.path.clone());
    let with_spill = |failure: Failure| match &spill_path {
        Some(path) => failure.extra(json!({ "spillPath": path })),
        None => failure,
    };
    if timed_out {
        return Err(with_spill(Failure::new("timeout", "timeout")));
    }
    if aborted {
        return Err(with_spill(Failure::new("aborted", "aborted")));
    }
    if let Some(error) = spill.as_ref().and_then(|spill| spill.failed.clone()) {
        return Err(Failure::new(
            "unknown",
            format!("Failed to preserve complete shell output: {error}"),
        ));
    }
    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => return Err(Failure::new("spawn_error", error)),
        None => {
            return Err(Failure::new(
                "spawn_error",
                "process did not report its exit",
            ));
        }
    };
    let mut result = json!({ "exitCode": sys::exit_code(status) });
    if let Some(path) = spill_path {
        result["spillPath"] = json!(path);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRACE: Duration = Duration::from_millis(10);

    /// An expired grace and an empty channel: `Some` renews the grace, `None` ends the wait.
    fn expired(throttle: &Throttle, seen: &mut usize, forced: bool) -> bool {
        let (_sender, receiver) = mpsc::channel();
        let mut idle_until = Some(Instant::now());
        receive(
            &receiver,
            GRACE,
            &mut idle_until,
            throttle,
            seen,
            forced,
            GRACE,
        )
        .is_some()
    }

    #[test]
    fn grace_ends_when_no_reader_is_throttled() {
        assert!(!expired(&Throttle::default(), &mut 0, false));
    }

    #[test]
    fn grace_renews_while_a_reader_waits_or_was_just_released() {
        let throttle = Throttle::default();
        throttle.waiting.store(1, Ordering::SeqCst);
        assert!(expired(&throttle, &mut 0, false));
        throttle.waiting.store(0, Ordering::SeqCst);
        throttle.releases.store(1, Ordering::SeqCst);
        let mut seen = 0;
        assert!(expired(&throttle, &mut seen, false));
        // The release was seen once; without a new one the grace ends.
        assert!(!expired(&throttle, &mut seen, false));
    }

    #[test]
    fn grace_never_renews_after_a_kill() {
        let throttle = Throttle::default();
        throttle.waiting.store(1, Ordering::SeqCst);
        assert!(!expired(&throttle, &mut 0, true));
    }

    #[test]
    fn queued_messages_are_taken_before_the_grace_ends() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Message::Data(0, vec![1])).unwrap();
        let mut idle_until = Some(Instant::now());
        let message = receive(
            &receiver,
            GRACE,
            &mut idle_until,
            &Throttle::default(),
            &mut 0,
            true,
            GRACE,
        );
        assert!(matches!(message, Some(Ok(Message::Data(0, _)))));
    }
}
