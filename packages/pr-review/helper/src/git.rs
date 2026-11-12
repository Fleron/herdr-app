use crate::{Context, Error, Result, checked, run};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const PAGE_BYTES: usize = 512 * 1024;
const PAGE_ITEMS: usize = 100;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    key: String,
    repo: Value,
    number: u64,
    base_oid: String,
    head_oid: String,
    merge_base: String,
    checkout: PathBuf,
    git_dir: PathBuf,
    cache: PathBuf,
    file_count: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFile {
    path: String,
    old_path: Option<String>,
    status: String,
    added: u64,
    removed: u64,
    binary: bool,
    old_mode: String,
    new_mode: String,
}

pub fn handle(ctx: &Context, request: &Value) -> Option<Result<Value>> {
    match request["op"].as_str()? {
        "git.prepare" => Some(prepare(ctx, request, false)),
        "git.update" => Some(prepare(ctx, request, true)),
        "git.status" => {
            Some(stored_target(ctx, request).and_then(|target| checkout_status(&target)))
        }
        "git.files" => Some(stored_target(ctx, request).and_then(|target| {
            let path = revision_dir(ctx, &target.key).join("files.jsonl");
            page(&path, request, "files")
        })),
        "git.diff" => Some(diff(ctx, request)),
        _ => None,
    }
}

fn value_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new("INVALID_REQUEST", format!("Missing {key}")))
}

fn repo_key(repo: &Value) -> Result<String> {
    let host = value_str(repo, "host")?;
    let owner = value_str(repo, "owner")?;
    let name = value_str(repo, "name")?;
    if host != "github.com"
        || [owner, name].iter().any(|part| {
            *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err(Error::new(
            "UNSUPPORTED_REPOSITORY",
            "A local GitHub.com repository is required",
        ));
    }
    Ok(format!("{host}/{owner}/{name}").to_ascii_lowercase())
}

fn session_key(repo: &Value, number: u64) -> Result<String> {
    if number == 0 {
        return Err(Error::new(
            "INVALID_REQUEST",
            "A positive pull request number is required",
        ));
    }
    Ok(format!("{}#{number}", repo_key(repo)?))
}

fn oid(value: &Value, field: &str) -> Result<String> {
    let text = value_str(value, field)?;
    if ![40, 64].contains(&text.len()) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::new("INVALID_REVISION", format!("Invalid {field}")));
    }
    Ok(text.to_ascii_lowercase())
}

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn revision_dir(ctx: &Context, key: &str) -> PathBuf {
    ctx.root.join("git/diffs").join(digest(key))
}

fn git_args(cache: &Path, args: &[String]) -> Vec<String> {
    let mut all = vec![
        "-c".into(),
        "core.hooksPath=/dev/null".into(),
        "-c".into(),
        "core.fsmonitor=false".into(),
        "-c".into(),
        "diff.suppressBlankEmpty=false".into(),
        "-c".into(),
        "core.quotepath=false".into(),
        "-c".into(),
        "diff.noprefix=false".into(),
        "-c".into(),
        "diff.mnemonicprefix=false".into(),
        "-c".into(),
        "gc.auto=0".into(),
        "-c".into(),
        "credential.helper=".into(),
        "-c".into(),
        "credential.helper=!gh auth git-credential".into(),
        "--git-dir".into(),
        cache.to_string_lossy().into_owned(),
    ];
    all.extend_from_slice(args);
    all
}

fn git(cache: &Path, args: &[String]) -> Result<String> {
    checked("git", &git_args(cache, args), None, Duration::from_secs(60))
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).to_owned()).collect()
}

fn fetch(cache: &Path, wanted: &str, fallback: &str) -> Result<()> {
    if is_commit(cache, wanted) {
        return Ok(());
    }
    let prefix = [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "origin",
    ];
    let mut args = strings(&prefix);
    args.push(wanted.to_owned());
    let direct = run(
        "git",
        &git_args(cache, &args),
        None,
        Duration::from_secs(600),
    )?;
    if direct.code != 0 {
        let mut args = strings(&prefix);
        args.push(fallback.to_owned());
        checked(
            "git",
            &git_args(cache, &args),
            None,
            Duration::from_secs(600),
        )?;
    }
    if !is_commit(cache, wanted) {
        return Err(Error::new(
            "REVISION_UNAVAILABLE",
            "The exact requested revision could not be fetched; refresh the pull request",
        ));
    }
    Ok(())
}

fn is_commit(cache: &Path, oid: &str) -> bool {
    git(cache, &strings(&["cat-file", "-t", oid])).is_ok_and(|kind| kind.trim() == "commit")
}

fn prepare(ctx: &Context, request: &Value, update: bool) -> Result<Value> {
    let repo = &request["repo"];
    let pr = &request["pr"];
    let number = pr["number"]
        .as_u64()
        .ok_or_else(|| Error::new("INVALID_REQUEST", "Missing PR number"))?;
    let session = session_key(repo, number)?;
    let _lock = ctx.lock("git", &repo_key(repo)?)?;
    let base_oid = oid(pr, "baseOid")?;
    let head_oid = oid(pr, "headOid")?;
    if base_oid.len() != head_oid.len() {
        return Err(Error::new(
            "INVALID_REVISION",
            "Base and head use different object formats",
        ));
    }
    let old: Option<Target> = ctx
        .read("git-targets", &session)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| Error::new("INVALID_STATE", e.to_string()))?;
    if let Some(target) = &old {
        let status = checkout_status(target)?;
        let changed = target.base_oid != base_oid || target.head_oid != head_oid;
        if !update || !changed {
            return Ok(
                json!({"target": target, "updateAvailable": changed, "checkoutStatus": status}),
            );
        }
        require_updateable(&status)?;
    } else if update {
        return Err(Error::new(
            "MISSING_CHECKOUT",
            "Open this pull request before updating it",
        ));
    }
    let key = format!("{session}@{base_oid}..{head_oid}");
    let cache = ctx.root.join("git/repos").join(digest(&repo_key(repo)?));
    let fetch_url = value_str(repo, "fetchUrl")?;
    if !cache.exists() {
        fs::create_dir_all(cache.parent().unwrap())?;
        let format = if head_oid.len() == 64 {
            "sha256"
        } else {
            "sha1"
        };
        checked(
            "git",
            &strings(&[
                "init",
                "--bare",
                &format!("--object-format={format}"),
                cache
                    .to_str()
                    .ok_or_else(|| Error::new("INVALID_PATH", "Cache path is not UTF-8"))?,
            ]),
            None,
            Duration::from_secs(60),
        )?;
        git(&cache, &strings(&["remote", "add", "origin", fetch_url]))?;
    } else if git(&cache, &strings(&["remote", "get-url", "origin"]))?.trim() != fetch_url {
        return Err(Error::new(
            "OWNERSHIP_MISMATCH",
            "The cached repository remote has changed; it will not be reused",
        ));
    }
    fetch(&cache, &head_oid, &format!("refs/pull/{number}/head"))?;
    let base = value_str(pr, "base")?;
    fetch(&cache, &base_oid, &format!("refs/heads/{base}"))?;
    git(
        &cache,
        &strings(&[
            "update-ref",
            &format!("refs/herdr-pr/{number}/head"),
            &head_oid,
        ]),
    )?;
    git(
        &cache,
        &strings(&[
            "update-ref",
            &format!("refs/herdr-pr/{number}/base"),
            &base_oid,
        ]),
    )?;
    let merge_base = git(&cache, &strings(&["merge-base", &base_oid, &head_oid]))?
        .trim()
        .to_owned();
    let checkout = old
        .as_ref()
        .map(|target| target.checkout.clone())
        .unwrap_or_else(|| {
            ctx.root
                .join("git/checkouts")
                .join(digest(&repo_key(repo).unwrap()))
                .join(format!("pr-{number}"))
        });
    let mut target = Target {
        key,
        repo: repo.clone(),
        number,
        base_oid,
        head_oid,
        merge_base,
        checkout,
        git_dir: PathBuf::new(),
        cache,
        file_count: 0,
    };
    target.file_count = build_files(ctx, &target)?;
    if let Some(previous) = &old {
        require_updateable(&checkout_status(previous)?)?;
        checkout_git(
            &target,
            &strings(&[
                "checkout",
                "--detach",
                "--no-overwrite-ignore",
                &target.head_oid,
            ]),
        )?;
    } else {
        if target.checkout.exists() {
            return Err(Error::new(
                "OWNERSHIP_MISMATCH",
                "The checkout destination already exists and is not registered; it will not be overwritten",
            ));
        }
        fs::create_dir_all(target.checkout.parent().unwrap())?;
        git(
            &target.cache,
            &strings(&[
                "worktree",
                "add",
                "--detach",
                target
                    .checkout
                    .to_str()
                    .ok_or_else(|| Error::new("INVALID_PATH", "Checkout path is not UTF-8"))?,
                &target.head_oid,
            ]),
        )?;
    }
    target.git_dir = PathBuf::from(
        checkout_git(&target, &strings(&["rev-parse", "--absolute-git-dir"]))?.trim(),
    );
    ctx.write(
        "git-targets",
        &session,
        &serde_json::to_value(&target).map_err(|e| Error::new("INVALID_STATE", e.to_string()))?,
    )?;
    Ok(
        json!({"target": target, "updateAvailable": false, "checkoutStatus": checkout_status(&target)?}),
    )
}

fn stored_target(ctx: &Context, request: &Value) -> Result<Target> {
    let supplied = &request["target"];
    let number = supplied["number"]
        .as_u64()
        .ok_or_else(|| Error::new("INVALID_REQUEST", "Missing target number"))?;
    let session = session_key(&supplied["repo"], number)?;
    let value = ctx.read("git-targets", &session)?.ok_or_else(|| {
        Error::new(
            "MISSING_CHECKOUT",
            "The pull request checkout is not registered",
        )
    })?;
    let target: Target =
        serde_json::from_value(value).map_err(|e| Error::new("INVALID_STATE", e.to_string()))?;
    if supplied["key"].as_str() != Some(&target.key) {
        return Err(Error::new(
            "STALE_TARGET",
            "The displayed revision changed; reopen the pull request",
        ));
    }
    Ok(target)
}

fn checkout_git(target: &Target, args: &[String]) -> Result<String> {
    let mut all = strings(&[
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
    ]);
    all.push(target.checkout.to_string_lossy().into_owned());
    all.extend_from_slice(args);
    checked("git", &all, None, Duration::from_secs(60))
}

fn checkout_status(target: &Target) -> Result<Value> {
    if !target.checkout.is_dir() {
        return Ok(
            json!({"owned":false,"matchesPinned":false,"dirty":false,"reason":"The registered checkout is missing"}),
        );
    }
    let actual_dir = checkout_git(target, &strings(&["rev-parse", "--absolute-git-dir"]))?;
    let common = checkout_git(
        target,
        &strings(&["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    )?;
    let actual_top = checkout_git(target, &strings(&["rev-parse", "--show-toplevel"]))?;
    let owned = fs::canonicalize(actual_dir.trim()).ok() == fs::canonicalize(&target.git_dir).ok()
        && fs::canonicalize(common.trim()).ok() == fs::canonicalize(&target.cache).ok()
        && fs::canonicalize(actual_top.trim()).ok() == fs::canonicalize(&target.checkout).ok();
    let head = checkout_git(target, &strings(&["rev-parse", "HEAD"]))?
        .trim()
        .to_owned();
    let mut sym_args = strings(&["-C"]);
    sym_args.push(target.checkout.to_string_lossy().into_owned());
    sym_args.extend(strings(&["symbolic-ref", "-q", "HEAD"]));
    let branch = run("git", &sym_args, None, Duration::from_secs(30))?;
    if ![0, 1].contains(&branch.code) {
        return Err(Error::new(
            "GIT_STATUS",
            "Unable to determine checkout branch",
        ));
    }
    let detached = branch.code == 1;
    let dirty = !checkout_git(
        target,
        &strings(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    )?
    .is_empty();
    let matches = owned && detached && head == target.head_oid;
    let reason = if !owned {
        "The checkout Git directory no longer matches its registration"
    } else if !detached || head != target.head_oid {
        "The checkout was switched to another branch or revision"
    } else if dirty {
        "The checkout contains local changes"
    } else {
        ""
    };
    Ok(
        json!({"owned":owned,"matchesPinned":matches,"dirty":dirty,"head":head,
        "branch":if detached { Value::Null } else { json!(branch.stdout.trim()) },"reason":reason}),
    )
}

fn require_updateable(status: &Value) -> Result<()> {
    if status["owned"] != true || status["matchesPinned"] != true {
        return Err(Error::new(
            "OWNERSHIP_MISMATCH",
            status["reason"]
                .as_str()
                .unwrap_or("Checkout ownership changed"),
        ));
    }
    if status["dirty"] == true {
        return Err(Error::new(
            "DIRTY_CHECKOUT",
            "Keep or commit your local changes before updating; no files were reset",
        ));
    }
    Ok(())
}

fn diff_args(target: &Target, output: &Path, format: &str) -> Vec<String> {
    strings(&[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--diff-algorithm=myers",
        "--ignore-submodules=none",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--find-renames",
        format,
        &format!("--output={}", output.display()),
        &target.merge_base,
        &target.head_oid,
        "--",
    ])
}

fn utf8(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        Error::new(
            "NON_UTF8_PATH",
            "A changed file has a non-UTF-8 path; inspect it in the terminal",
        )
    })
}

fn build_files(ctx: &Context, target: &Target) -> Result<usize> {
    let dir = revision_dir(ctx, &target.key);
    fs::create_dir_all(&dir)?;
    let raw = dir.join("raw");
    let stats = dir.join("numstat");
    let mut raw_args = diff_args(target, &raw, "--raw");
    raw_args.insert(1, "-z".into());
    git(&target.cache, &raw_args)?;
    let mut stat_args = diff_args(target, &stats, "--numstat");
    stat_args.insert(1, "-z".into());
    git(&target.cache, &stat_args)?;
    let raw_bytes = fs::read(&raw)?;
    let mut raw_parts = raw_bytes.split(|b| *b == 0).filter(|part| !part.is_empty());
    let mut files = Vec::new();
    while let Some(header) = raw_parts.next() {
        let header = std::str::from_utf8(header)
            .map_err(|_| Error::new("INVALID_DIFF", "Invalid Git raw header"))?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 5 || !fields[0].starts_with(':') {
            return Err(Error::new("INVALID_DIFF", "Unexpected Git raw diff record"));
        }
        let status = fields[4][..1].to_owned();
        let first = utf8(
            raw_parts
                .next()
                .ok_or_else(|| Error::new("INVALID_DIFF", "Missing Git path"))?,
        )?;
        let (path, old_path) = if status == "R" || status == "C" {
            (
                utf8(
                    raw_parts
                        .next()
                        .ok_or_else(|| Error::new("INVALID_DIFF", "Missing renamed Git path"))?,
                )?,
                Some(first),
            )
        } else {
            (first, None)
        };
        files.push(ChangedFile {
            path,
            old_path,
            status,
            added: 0,
            removed: 0,
            binary: false,
            old_mode: fields[0][1..].into(),
            new_mode: fields[1].into(),
        });
    }
    let indices: HashMap<String, usize> = files
        .iter()
        .enumerate()
        .map(|(i, file)| (file.path.clone(), i))
        .collect();
    let stat_bytes = fs::read(&stats)?;
    let mut parts = stat_bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty());
    while let Some(record) = parts.next() {
        let mut fields = record.splitn(3, |b| *b == b'\t');
        let added = fields.next().unwrap_or_default();
        let removed = fields
            .next()
            .ok_or_else(|| Error::new("INVALID_DIFF", "Invalid Git numstat"))?;
        let name = fields
            .next()
            .ok_or_else(|| Error::new("INVALID_DIFF", "Missing Git numstat path"))?;
        let name = if name.is_empty() {
            parts
                .next()
                .ok_or_else(|| Error::new("INVALID_DIFF", "Missing original numstat path"))?;
            parts
                .next()
                .ok_or_else(|| Error::new("INVALID_DIFF", "Missing renamed numstat path"))?
        } else {
            name
        };
        let index = indices.get(&utf8(name)?).ok_or_else(|| {
            Error::new("INVALID_DIFF", "Numstat path does not match changed files")
        })?;
        files[*index].binary = added == b"-" || removed == b"-";
        if !files[*index].binary {
            files[*index].added = std::str::from_utf8(added)
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::new("INVALID_DIFF", "Invalid added line count"))?;
            files[*index].removed = std::str::from_utf8(removed)
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::new("INVALID_DIFF", "Invalid removed line count"))?;
        }
    }
    let destination = dir.join("files.jsonl");
    let temp = dir.join("files.jsonl.tmp");
    let mut out = BufWriter::new(File::create(&temp)?);
    for file in &files {
        serde_json::to_writer(&mut out, file)
            .map_err(|e| Error::new("INVALID_DIFF", e.to_string()))?;
        out.write_all(b"\n")?;
    }
    out.flush()?;
    fs::rename(temp, destination)?;
    Ok(files.len())
}

fn page(path: &Path, request: &Value, field: &str) -> Result<Value> {
    let cursor = match &request["cursor"] {
        Value::Null => 0,
        Value::String(value) => value
            .parse::<u64>()
            .map_err(|_| Error::new("INVALID_CURSOR", "Invalid diff page cursor"))?,
        Value::Number(value) => value
            .as_u64()
            .ok_or_else(|| Error::new("INVALID_CURSOR", "Invalid diff page cursor"))?,
        _ => return Err(Error::new("INVALID_CURSOR", "Invalid diff page cursor")),
    };
    let file = File::open(path)?;
    let length = file.metadata()?.len();
    if cursor > length {
        return Err(Error::new(
            "INVALID_CURSOR",
            "Diff page cursor is outside its revision",
        ));
    }
    let mut input = BufReader::new(file);
    input.seek(SeekFrom::Start(cursor))?;
    let mut items = Vec::new();
    let mut size = 0;
    let mut position = cursor;
    loop {
        let before = position;
        let mut line = String::new();
        let read = input.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        if read > PAGE_BYTES {
            return Err(Error::new(
                "DIFF_LINE_TOO_LARGE",
                "One diff row exceeds the viewer's memory budget; inspect this file in the terminal or on GitHub",
            ));
        }
        if !items.is_empty() && (size + read > PAGE_BYTES || items.len() == PAGE_ITEMS) {
            position = before;
            break;
        }
        items.push(
            serde_json::from_str::<Value>(&line)
                .map_err(|e| Error::new("INVALID_DIFF", e.to_string()))?,
        );
        size += read;
        position += read as u64;
    }
    let mut result = json!({"nextCursor":if position < length { json!(position.to_string()) } else { Value::Null }});
    result[field] = json!(items);
    Ok(result)
}

fn diff(ctx: &Context, request: &Value) -> Result<Value> {
    let target = stored_target(ctx, request)?;
    let file = value_str(request, "file")?;
    let mut found = None;
    for line in BufReader::new(File::open(
        revision_dir(ctx, &target.key).join("files.jsonl"),
    )?)
    .lines()
    {
        let item: ChangedFile =
            serde_json::from_str(&line?).map_err(|e| Error::new("INVALID_DIFF", e.to_string()))?;
        if item.path == file {
            found = Some(item);
            break;
        }
    }
    let changed = found.ok_or_else(|| {
        Error::new(
            "INVALID_PATH",
            "This file is not part of the pinned pull request diff",
        )
    })?;
    let dir = revision_dir(ctx, &target.key);
    let rows = dir.join(format!("{}.v2.jsonl", digest(file)));
    let _lock = ctx.lock("git-diff", &format!("{}:{file}", target.key))?;
    if !rows.exists() {
        let patch = dir.join(format!("{}.v2.patch", digest(file)));
        let mut args = diff_args(&target, &patch, "--unified=3");
        if let Some(old) = &changed.old_path {
            args.push(format!(":(literal){old}"));
        }
        args.push(format!(":(literal){file}"));
        git(&target.cache, &args)?;
        build_rows(&patch, &rows, &changed)?;
    }
    let mut result = page(&rows, request, "rows")?;
    result["file"] =
        serde_json::to_value(changed).map_err(|e| Error::new("INVALID_DIFF", e.to_string()))?;
    Ok(result)
}

fn range_start(part: &str) -> Result<u64> {
    part[1..]
        .split(',')
        .next()
        .unwrap_or_default()
        .parse()
        .map_err(|_| Error::new("INVALID_DIFF", "Invalid Git hunk range"))
}

fn quoted_path(path: &str) -> String {
    let mut text = String::new();
    let mut quoted = false;
    for ch in path.chars() {
        let escape = match ch {
            '\u{7}' => Some("\\a"),
            '\u{8}' => Some("\\b"),
            '\t' => Some("\\t"),
            '\n' => Some("\\n"),
            '\u{b}' => Some("\\v"),
            '\u{c}' => Some("\\f"),
            '\r' => Some("\\r"),
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            _ => None,
        };
        if let Some(escape) = escape {
            text.push_str(escape);
            quoted = true;
        } else if ch.is_ascii_control() {
            text.push_str(&format!("\\{:03o}", ch as u32));
            quoted = true;
        } else {
            text.push(ch);
        }
    }
    if quoted { format!("\"{text}\"") } else { text }
}

fn build_rows(patch: &Path, rows: &Path, file: &ChangedFile) -> Result<()> {
    let temp = rows.with_extension("tmp");
    let mut out = BufWriter::new(File::create(&temp)?);
    let mut old = 0;
    let mut next = 0;
    let mut in_hunk = false;
    let mut selected_file = false;
    let mut found_header = false;
    let expected_header = format!(
        "diff --git {} {}",
        quoted_path(&format!(
            "a/{}",
            file.old_path.as_deref().unwrap_or(&file.path)
        )),
        quoted_path(&format!("b/{}", file.path))
    );
    let mut input = BufReader::new(File::open(patch)?);
    loop {
        let mut bytes = Vec::new();
        let read = (&mut input)
            .take(PAGE_BYTES as u64 + 1)
            .read_until(b'\n', &mut bytes)?;
        if read == 0 {
            break;
        }
        if read > PAGE_BYTES {
            if !selected_file {
                if bytes.last() != Some(&b'\n') {
                    input.skip_until(b'\n')?;
                }
                continue;
            }
            return Err(Error::new(
                "DIFF_LINE_TOO_LARGE",
                "One diff row exceeds the viewer's memory budget; inspect this file in the terminal or on GitHub",
            ));
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        if bytes.starts_with(b"diff --git ") {
            in_hunk = false;
            selected_file = bytes == expected_header.as_bytes();
            found_header |= selected_file;
            continue;
        }
        if !selected_file {
            continue;
        }
        let line = String::from_utf8(bytes).map_err(|_| {
            Error::new(
                "NON_UTF8_DIFF",
                "This diff is not UTF-8 text; inspect it in the terminal",
            )
        })?;
        let row = if line.starts_with("@@ ") {
            let parts: Vec<_> = line.split_whitespace().collect();
            if parts.len() < 4 || !parts[1].starts_with('-') || !parts[2].starts_with('+') {
                return Err(Error::new("INVALID_DIFF", "Invalid Git hunk header"));
            }
            old = range_start(parts[1])?;
            next = range_start(parts[2])?;
            in_hunk = true;
            json!({"kind":"@","old":null,"next":null,"text":line})
        } else if in_hunk {
            match line.as_bytes().first() {
                Some(b' ') => {
                    let row = json!({"kind":" ","old":old,"next":next,"text":&line[1..]});
                    old += 1;
                    next += 1;
                    row
                }
                Some(b'-') => {
                    let row = json!({"kind":"-","old":old,"next":null,"text":&line[1..]});
                    old += 1;
                    row
                }
                Some(b'+') => {
                    let row = json!({"kind":"+","old":null,"next":next,"text":&line[1..]});
                    next += 1;
                    row
                }
                Some(b'\\') => json!({"kind":"@","old":null,"next":null,"text":line}),
                _ => return Err(Error::new("INVALID_DIFF", "Unexpected Git patch content")),
            }
        } else {
            continue;
        };
        let encoded =
            serde_json::to_vec(&row).map_err(|e| Error::new("INVALID_DIFF", e.to_string()))?;
        if encoded.len() + 1 > PAGE_BYTES {
            return Err(Error::new(
                "DIFF_LINE_TOO_LARGE",
                "One diff row exceeds the viewer's memory budget; inspect this file in the terminal or on GitHub",
            ));
        }
        out.write_all(&encoded)?;
        out.write_all(b"\n")?;
    }
    if !found_header {
        return Err(Error::new(
            "INVALID_DIFF",
            "Git did not return the requested file's patch section",
        ));
    }
    out.flush()?;
    fs::rename(temp, rows)?;
    Ok(())
}
