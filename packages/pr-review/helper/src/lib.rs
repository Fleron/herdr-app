use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub mod git;
pub mod github;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::new("IO", value.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", value.to_string())
    }
}

pub struct Context {
    pub root: PathBuf,
}

pub fn digest(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}

fn durable_directory(path: &Path) -> Result<()> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => return Err(Error::new("INVALID_PATH", "State path is not a directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("INVALID_PATH", "Missing parent directory"))?;
    durable_directory(parent)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(error.into()),
    }
    File::open(parent)?.sync_all()?;
    Ok(())
}

impl Context {
    pub fn path(&self, kind: &str, key: &str) -> PathBuf {
        self.root.join(kind).join(format!("{}.json", digest(key)))
    }
    pub fn read(&self, kind: &str, key: &str) -> Result<Option<Value>> {
        match fs::read(self.path(kind, key)) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    pub fn write(&self, kind: &str, key: &str, value: &Value) -> Result<()> {
        let path = self.path(kind, key);
        let parent = path
            .parent()
            .ok_or_else(|| Error::new("INVALID_PATH", "Missing state directory"))?;
        durable_directory(parent)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp = parent.join(format!(".{}-{nonce}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let result = (|| -> Result<()> {
            let mut file = options.open(&temp)?;
            serde_json::to_writer(&mut file, value)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temp, &path)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    pub fn lock(&self, kind: &str, key: &str) -> Result<File> {
        let path = self.path("locks", &format!("{kind}:{key}"));
        durable_directory(path.parent().unwrap())?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(path)?;
        file.lock()?;
        Ok(file)
    }
}

#[derive(Debug)]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn capture(mut stream: impl Read, overflow: Arc<AtomicBool>) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len() + count > 64 * 1024 * 1024 {
            overflow.store(true, Ordering::Relaxed);
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

pub fn run(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<CommandOutput> {
    let mut command = Command::new(program);
    if Path::new(program)
        .file_name()
        .is_some_and(|name| name == "git")
    {
        const LOCAL: &[&str] = &[
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
            "GIT_OBJECT_DIRECTORY",
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_IMPLICIT_WORK_TREE",
            "GIT_GRAFT_FILE",
            "GIT_INDEX_FILE",
            "GIT_NO_REPLACE_OBJECTS",
            "GIT_REPLACE_REF_BASE",
            "GIT_PREFIX",
            "GIT_SHALLOW_FILE",
            "GIT_COMMON_DIR",
            "GIT_NAMESPACE",
            "GIT_ATTR_SOURCE",
            "GIT_INTERNAL_SUPER_PREFIX",
            "GIT_CEILING_DIRECTORIES",
            "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        ];
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if LOCAL.contains(&name.as_ref())
                || name.starts_with("GIT_CONFIG_KEY_")
                || name.starts_with("GIT_CONFIG_VALUE_")
            {
                command.env_remove(key);
            }
        }
        command.args(["-c", "core.hooksPath=/dev/null"]);
    }
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| Error::new("SPAWN_FAILED", format!("Cannot start {program}: {e}")))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out_flag = overflow.clone();
    let err_flag = overflow.clone();
    let out_done = Arc::new(AtomicBool::new(false));
    let err_done = Arc::new(AtomicBool::new(false));
    let out_finished = out_done.clone();
    let err_finished = err_done.clone();
    let out = thread::spawn(move || {
        let result = capture(stdout, out_flag);
        out_finished.store(true, Ordering::Release);
        result
    });
    let err = thread::spawn(move || {
        let result = capture(stderr, err_flag);
        err_finished.store(true, Ordering::Release);
        result
    });
    let start = Instant::now();
    let mut failure = None;
    let mut exited = None;
    let status = loop {
        if overflow.load(Ordering::Relaxed) || start.elapsed() > timeout {
            failure = Some(if overflow.load(Ordering::Relaxed) {
                Error::new(
                    "OUTPUT_LIMIT",
                    format!("{program} exceeded the per-command output budget"),
                )
            } else {
                Error::new(
                    "TIMEOUT",
                    format!("{program} exceeded its request deadline"),
                )
            });
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break child.wait()?;
        }
        if exited.is_none() {
            exited = child.try_wait()?;
        }
        if let Some(status) = exited
            && out_done.load(Ordering::Acquire)
            && err_done.load(Ordering::Acquire)
        {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = out
        .join()
        .map_err(|_| Error::new("IO", "Command output reader failed"))??;
    let stderr = err
        .join()
        .map_err(|_| Error::new("IO", "Command error reader failed"))??;
    if let Some(error) = failure {
        return Err(error);
    }
    if overflow.load(Ordering::Relaxed) {
        return Err(Error::new(
            "OUTPUT_LIMIT",
            "Command output exceeded its byte budget",
        ));
    }
    Ok(CommandOutput {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8(stdout)
            .map_err(|_| Error::new("INVALID_UTF8", "Command output is not UTF-8"))?,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

pub fn checked(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<String> {
    let output = run(program, args, cwd, timeout)?;
    if output.code != 0 {
        return Err(Error::new(
            "COMMAND_FAILED",
            format!("{program} failed: {}", output.stderr.trim()),
        )
        .with_details(json!({"exit":output.code})));
    }
    Ok(output.stdout)
}

pub fn dispatch(ctx: &Context, request: &Value) -> Result<Value> {
    git::handle(ctx, request)
        .or_else(|| github::handle(ctx, request))
        .unwrap_or_else(|| {
            Err(Error::new(
                "UNKNOWN_OPERATION",
                "Unknown PR helper operation",
            ))
        })
}
