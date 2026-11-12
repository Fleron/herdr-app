use crate::{Context, Error, Result, checked, run};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const PAGE: u64 = 25;
const PAGE_INFO: &str = "pageInfo { hasNextPage endCursor }";
const PR_FIELDS: &str = r#"
id number title url state isDraft author { login ... on Node { id } } baseRefName headRefName baseRefOid headRefOid
additions deletions changedFiles reviewDecision mergeQueueEntry { position }
commits(last:1) { nodes { commit { statusCheckRollup { state contexts {
totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
} } } } }
"#;

pub fn handle(ctx: &Context, request: &Value) -> Option<Result<Value>> {
    let op = request.get("op")?.as_str()?;
    Some(match op {
        "github.repo" => resolve_repo(ctx, request),
        "github.list"
        | "github.pr"
        | "github.checks"
        | "github.reviews"
        | "github.activity"
        | "github.threads"
        | "github.thread-comments" => read_operation(&mut Gh { ctx }, request),
        "draft.get" => draft_get(ctx, request),
        "draft.save" => draft_save(ctx, request),
        "review.submit" => submit(ctx, &mut Gh { ctx }, request),
        "review.reconcile" => reconcile(ctx, &mut Gh { ctx }, request),
        "review.adopt" => adopt(ctx, &mut Gh { ctx }, request),
        "review.restart" => restart(ctx, &mut Gh { ctx }, request),
        _ => return None,
    })
}

fn text<'a>(v: &'a Value, field: &str) -> Result<&'a str> {
    v.get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new("INVALID_REQUEST", format!("Missing {field}")))
}

fn number(v: &Value) -> Result<u64> {
    v.get("number")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::new("INVALID_REQUEST", "Invalid pull request number"))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn repository(v: &Value) -> Result<&Value> {
    let repo = &v["repo"];
    if text(repo, "host")? != "github.com" {
        return Err(Error::new(
            "UNSUPPORTED_HOST",
            "This version supports github.com repositories",
        ));
    }
    for field in ["owner", "name"] {
        if !text(repo, field)?
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return Err(Error::new(
                "INVALID_REPOSITORY",
                "Invalid GitHub repository identity",
            ));
        }
    }
    Ok(repo)
}

fn remote_identity(remote: &str) -> Result<(String, String, String)> {
    let remote = remote.trim();
    let (path, ssh) = if let Some(path) = remote.strip_prefix("git@github.com:") {
        (path, true)
    } else if let Some(path) = remote.strip_prefix("ssh://git@github.com/") {
        (path, true)
    } else if let Some(rest) = remote.strip_prefix("https://") {
        let (authority, path) = rest
            .split_once('/')
            .ok_or_else(|| Error::new("INVALID_REPOSITORY", "Origin has no repository path"))?;
        if authority.rsplit('@').next() != Some("github.com") {
            return Err(Error::new(
                "UNSUPPORTED_HOST",
                "Origin must point to github.com",
            ));
        }
        (path, false)
    } else {
        return Err(Error::new(
            "UNSUPPORTED_HOST",
            "Origin must be a github.com HTTPS or SSH remote",
        ));
    };
    let path = path
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim_end_matches('/'));
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
    {
        return Err(Error::new(
            "INVALID_REPOSITORY",
            "Origin must identify one GitHub owner and repository",
        ));
    }
    let url = if ssh {
        format!("git@github.com:{}/{}.git", parts[0], parts[1])
    } else {
        format!("https://github.com/{}/{}.git", parts[0], parts[1])
    };
    Ok((parts[0].into(), parts[1].into(), url))
}

fn resolve_repo(ctx: &Context, request: &Value) -> Result<Value> {
    let cwd = text(request, "cwd")?;
    let local = checked(
        "git",
        &[
            "-C".into(),
            cwd.into(),
            "rev-parse".into(),
            "--show-toplevel".into(),
        ],
        None,
        Duration::from_secs(30),
    )?;
    let local = local.trim();
    let remote = checked(
        "git",
        &[
            "-C".into(),
            local.into(),
            "remote".into(),
            "get-url".into(),
            "origin".into(),
        ],
        None,
        Duration::from_secs(30),
    )?;
    let (owner, name, fetch_url) = remote_identity(&remote)?;
    let data = Gh { ctx }.query(
        "query($owner:String!,$name:String!){viewer{id login} repository(owner:$owner,name:$name){id name nameWithOwner url owner{login}}}",
        json!({"owner":owner,"name":name}), false).map_err(|e| e.error)?;
    let r = &data["repository"];
    if r.is_null() {
        return Err(Error::new(
            "REPOSITORY_NOT_FOUND",
            "GitHub cannot read this repository",
        ));
    }
    let owner = text(&r["owner"], "login")?;
    let name = text(r, "name")?;
    Ok(
        json!({"id":r["id"],"host":"github.com","owner":owner,"name":name,
        "nameWithOwner":r["nameWithOwner"],"key":format!("github.com/{owner}/{name}").to_lowercase(),
        "url":r["url"],"localPath":local,"fetchUrl":fetch_url,
        "viewerLogin":data["viewer"]["login"],"viewerId":data["viewer"]["id"]}),
    )
}

struct ApiFailure {
    error: Error,
    definite: bool,
}

trait Api {
    fn rest(&mut self, path: &str) -> std::result::Result<Value, ApiFailure>;
    fn query(
        &mut self,
        query: &str,
        variables: Value,
        mutation: bool,
    ) -> std::result::Result<Value, ApiFailure>;
}

struct Gh<'a> {
    ctx: &'a Context,
}

impl Api for Gh<'_> {
    fn rest(&mut self, path: &str) -> std::result::Result<Value, ApiFailure> {
        let args = vec![
            "api".into(),
            "--hostname".into(),
            "github.com".into(),
            "--method".into(),
            "GET".into(),
            "-H".into(),
            "Accept: application/vnd.github+json".into(),
            "-H".into(),
            "X-GitHub-Api-Version: 2022-11-28".into(),
            path.into(),
        ];
        let output =
            run("gh", &args, None, Duration::from_secs(90)).map_err(|error| ApiFailure {
                error,
                definite: true,
            })?;
        if output.code == 0 {
            return serde_json::from_str(&output.stdout).map_err(|_| ApiFailure {
                error: Error::new(
                    "INCOMPLETE_RESPONSE",
                    "GitHub returned incomplete review comments",
                ),
                definite: true,
            });
        }
        Err(ApiFailure {
            error: Error::new("GITHUB_API", output.stderr.trim()),
            definite: true,
        })
    }
    fn query(
        &mut self,
        query: &str,
        variables: Value,
        mutation: bool,
    ) -> std::result::Result<Value, ApiFailure> {
        let key = format!("{}-{}-{}", std::process::id(), now(), request_serial());
        let input = json!({"query":query,"variables":variables});
        self.ctx
            .write("github-requests", &key, &input)
            .map_err(|error| ApiFailure {
                error,
                definite: true,
            })?;
        let path = self.ctx.path("github-requests", &key);
        let args = vec![
            "api".into(),
            "graphql".into(),
            "--hostname".into(),
            "github.com".into(),
            "--input".into(),
            path.to_string_lossy().into_owned(),
        ];
        let output = run("gh", &args, None, Duration::from_secs(90));
        let _ = fs::remove_file(path);
        match output {
            Err(error) => {
                let definite = error.code == "SPAWN_FAILED";
                Err(ApiFailure { error, definite })
            }
            Ok(output) => decode_response(output.code, &output.stdout, &output.stderr, mutation),
        }
    }
}

fn request_serial() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    SERIAL.fetch_add(1, Ordering::Relaxed)
}

fn decode_response(
    code: i32,
    stdout: &str,
    stderr: &str,
    mutation: bool,
) -> std::result::Result<Value, ApiFailure> {
    if let Ok(response) = serde_json::from_str::<Value>(stdout) {
        if let Some(errors) = response
            .get("errors")
            .and_then(Value::as_array)
            .filter(|e| !e.is_empty())
        {
            let message = errors
                .iter()
                .filter_map(|e| e["message"].as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let definite = response["data"].is_null()
                && errors.iter().all(|e| {
                    e.get("path").is_none()
                        || matches!(
                            e["type"].as_str(),
                            Some("FORBIDDEN" | "NOT_FOUND" | "UNPROCESSABLE" | "BAD_USER_INPUT")
                        )
                });
            return Err(ApiFailure {
                error: Error::new("GITHUB_API", message),
                definite,
            });
        }
        if code == 0 && response.get("data").is_some_and(|d| !d.is_null()) {
            return Ok(response["data"].clone());
        }
    }
    let definite = !mutation
        || stderr.contains("HTTP 401")
        || stderr.contains("HTTP 403")
        || stderr.contains("HTTP 404")
        || stderr.contains("HTTP 422")
        || stderr.contains("gh auth login");
    Err(ApiFailure {
        error: Error::new(
            "GITHUB_TRANSPORT",
            if stderr.trim().is_empty() {
                "GitHub returned an incomplete response"
            } else {
                stderr.trim()
            },
        ),
        definite,
    })
}

fn variables(request: &Value) -> Result<Value> {
    let repo = repository(request)?;
    Ok(
        json!({"owner":text(repo,"owner")?,"name":text(repo,"name")?,
        "number":request["number"],"after":request.get("cursor").cloned().unwrap_or(Value::Null),"first":PAGE}),
    )
}

fn pr_query() -> String {
    format!(
        "query($owner:String!,$name:String!,$number:Int!){{viewer{{id login}} repository(owner:$owner,name:$name){{pullRequest(number:$number){{{PR_FIELDS} body}}}}}}"
    )
}

fn revision_changed(pr: &Value, target: &Value) -> bool {
    pr["headRefOid"] != target["headOid"]
        || (target["baseOid"].is_string() && pr["baseRefOid"] != target["baseOid"])
}

fn fetch_pr(api: &mut impl Api, request: &Value) -> Result<Value> {
    number(request)?;
    let data = api
        .query(&pr_query(), variables(request)?, false)
        .map_err(|e| e.error)?;
    if data["repository"]["pullRequest"].is_null() {
        return Err(Error::new(
            "PULL_REQUEST_NOT_FOUND",
            "GitHub cannot read this pull request",
        ));
    }
    Ok(data)
}

fn preflight(api: &mut impl Api, request: &Value) -> Result<Value> {
    let data=api.query("query($owner:String!,$name:String!,$number:Int!){viewer{id login} repository(owner:$owner,name:$name){pullRequest(number:$number){id number url headRefOid baseRefOid author{login ... on Node{id}}}}}",variables(request)?,false).map_err(|e|e.error)?;
    if data["repository"]["pullRequest"].is_null() {
        return Err(Error::new(
            "PULL_REQUEST_NOT_FOUND",
            "GitHub cannot read this pull request",
        ));
    }
    Ok(data)
}

fn read_operation(api: &mut impl Api, request: &Value) -> Result<Value> {
    let op = text(request, "op")?;
    if op == "github.thread-comments" {
        let data = api.query("query($id:ID!,$first:Int!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:$first,after:$after){nodes{id author{login} body createdAt url} pageInfo{hasNextPage endCursor}}}}}",
            json!({"id":text(request,"id")?,"first":PAGE,"after":request["cursor"]}), false).map_err(|e|e.error)?;
        return connection(&data["node"]["comments"], comment);
    }
    let vars = variables(request)?;
    if op == "github.pr" {
        let data = fetch_pr(api, request)?;
        return Ok(normalize_pr(&data["repository"]["pullRequest"]));
    }
    if op == "github.list" {
        let query = format!(
            "query($owner:String!,$name:String!,$first:Int!,$after:String){{repository(owner:$owner,name:$name){{pullRequests(states:OPEN,first:$first,after:$after,orderBy:{{field:CREATED_AT,direction:DESC}}){{nodes{{{PR_FIELDS}}} {PAGE_INFO}}}}}}}"
        );
        let data = api.query(&query, vars, false).map_err(|e| e.error)?;
        let c = &data["repository"]["pullRequests"];
        let mut page = connection(c, normalize_pr)?;
        page["prs"] = page["items"].take();
        page.as_object_mut().unwrap().remove("items");
        return Ok(page);
    }
    number(request)?;
    let (field, body) = match op {
        "github.checks" => ("checks", r#"commits(last:1){nodes{commit{statusCheckRollup{contexts(first:$first,after:$after){nodes{
          __typename ... on CheckRun{id name status conclusion detailsUrl title isRequired(pullRequestNumber:$number)}
          ... on StatusContext{id context state targetUrl description isRequired(pullRequestNumber:$number)}
        } $PAGE_INFO}}}}}"#.replace("$PAGE_INFO",PAGE_INFO)),
        "github.reviews" => ("latestOpinionatedReviews", "latestOpinionatedReviews(first:$first,after:$after){nodes{id author{login} state body submittedAt url} $PAGE_INFO}".replace("$PAGE_INFO",PAGE_INFO)),
        "github.activity" => ("timelineItems", r#"timelineItems(first:$first,after:$after){nodes{__typename
          ... on IssueComment{id author{login} body createdAt url}
          ... on PullRequestReview{id author{login} body submittedAt url state}
          ... on PullRequestCommit{commit{oid messageHeadline committedDate url author{name user{login}}}}
          ... on MergedEvent{id actor{login} createdAt}
          ... on ClosedEvent{id actor{login} createdAt}
          ... on ReopenedEvent{id actor{login} createdAt}
          ... on LabeledEvent{id actor{login} createdAt label{name color}}
          ... on UnlabeledEvent{id actor{login} createdAt label{name color}}
          ... on AutoMergeEnabledEvent{id actor{login} createdAt}
          ... on AutoMergeDisabledEvent{id actor{login} createdAt}
        } $PAGE_INFO}"#.replace("$PAGE_INFO",PAGE_INFO)),
        "github.threads" => ("reviewThreads", "reviewThreads(first:$first,after:$after){nodes{id path line startLine diffSide startDiffSide isResolved isOutdated viewerCanReply viewerCanResolve comments(first:1){nodes{id author{login} body createdAt url} totalCount $PAGE_INFO}} $PAGE_INFO}".replace("$PAGE_INFO",PAGE_INFO)),
        _ => return Err(Error::new("INVALID_REQUEST","Unknown GitHub operation")),
    };
    let query = format!(
        "query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{{body}}}}}}}"
    );
    let data = api.query(&query, vars, false).map_err(|e| e.error)?;
    let pr = &data["repository"]["pullRequest"];
    if pr.is_null() {
        return Err(Error::new(
            "PULL_REQUEST_NOT_FOUND",
            "GitHub cannot read this pull request",
        ));
    }
    let c = if field == "checks" {
        &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]
    } else {
        &pr[field]
    };
    if field == "checks" && c.is_null() {
        return Ok(json!({"items":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}));
    }
    match op {
        "github.checks" => connection(c, normalize_check),
        "github.reviews" => connection(c, normalize_review),
        "github.activity" => {
            let mut index = 0;
            connection(c, |v| {
                let value = activity(v, &request["cursor"], index);
                index += 1;
                value
            })
        }
        "github.threads" => connection(
            c,
            |v| json!({"id":v["id"],"path":v["path"],"line":v["line"],"startLine":v["startLine"],"side":v["diffSide"],"startSide":v["startDiffSide"],"isResolved":v["isResolved"],"isOutdated":v["isOutdated"],"viewerCanReply":v["viewerCanReply"],"viewerCanResolve":v["viewerCanResolve"],"comments":v["comments"]["nodes"].as_array().map(|a|a.iter().map(comment).collect::<Vec<_>>()).unwrap_or_default(),"commentsPageInfo":v["comments"]["pageInfo"],"commentCount":v["comments"]["totalCount"]}),
        ),
        _ => unreachable!(),
    }
}

fn connection(c: &Value, mut map: impl FnMut(&Value) -> Value) -> Result<Value> {
    let nodes = c["nodes"]
        .as_array()
        .ok_or_else(|| Error::new("INCOMPLETE_RESPONSE", "GitHub omitted a collection"))?;
    if !c["pageInfo"]["hasNextPage"].is_boolean()
        || (c["pageInfo"]["hasNextPage"] == true && !c["pageInfo"]["endCursor"].is_string())
    {
        return Err(Error::new(
            "INCOMPLETE_RESPONSE",
            "GitHub omitted pagination information",
        ));
    }
    if nodes.iter().any(Value::is_null) {
        return Err(Error::new(
            "INCOMPLETE_RESPONSE",
            "GitHub returned an unreadable item",
        ));
    }
    Ok(json!({"items":nodes.iter().map(&mut map).collect::<Vec<_>>(),"pageInfo":c["pageInfo"]}))
}

fn status(state: &str) -> &'static str {
    match state {
        "SUCCESS" => "passed",
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STALE"
        | "STARTUP_FAILURE" => "failed",
        "IN_PROGRESS" => "running",
        "PENDING" | "QUEUED" | "WAITING" | "REQUESTED" | "EXPECTED" => "waiting",
        "SKIPPED" => "skipped",
        "NEUTRAL" => "neutral",
        _ => "unknown",
    }
}

fn summary(pr: &Value) -> Value {
    let rollup = &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"];
    let contexts = &rollup["contexts"];
    let mut result = json!({"total":contexts["totalCount"].as_u64().unwrap_or(0),"passed":0,"failed":0,"running":0,"waiting":0,"skipped":0,"neutral":0,"unknown":0,"state":rollup["state"]});
    for field in ["checkRunCountsByState", "statusContextCountsByState"] {
        if let Some(counts) = contexts[field].as_array() {
            for item in counts {
                let key = status(item["state"].as_str().unwrap_or(""));
                result[key] =
                    json!(result[key].as_u64().unwrap_or(0) + item["count"].as_u64().unwrap_or(0));
            }
        }
    }
    let known: u64 = [
        "passed", "failed", "running", "waiting", "skipped", "neutral", "unknown",
    ]
    .iter()
    .map(|key| result[key].as_u64().unwrap_or(0))
    .sum();
    result["unknown"] = json!(
        result["unknown"].as_u64().unwrap_or(0)
            + result["total"].as_u64().unwrap_or(0).saturating_sub(known)
    );
    result
}

fn normalize_pr(v: &Value) -> Value {
    let state = if v["state"] == "MERGED" {
        "Merged"
    } else if v["state"] == "CLOSED" {
        "Closed"
    } else if !v["mergeQueueEntry"].is_null() {
        "In queue"
    } else if v["isDraft"] == true {
        "Draft"
    } else {
        "Open"
    };
    json!({"id":v["id"],"number":v["number"],"title":v["title"],"url":v["url"],"author":v["author"]["login"].as_str().unwrap_or("ghost"),
        "state":state,"isDraft":v["isDraft"],"base":v["baseRefName"],"head":v["headRefName"],"baseOid":v["baseRefOid"],"headOid":v["headRefOid"],
        "body":v["body"].as_str().unwrap_or(""),"additions":v["additions"],"deletions":v["deletions"],"changedFiles":v["changedFiles"],
        "reviewDecision":v["reviewDecision"],"queuePosition":v["mergeQueueEntry"]["position"],"checksSummary":summary(v)})
}

fn normalize_check(v: &Value) -> Value {
    let run = v["__typename"] == "CheckRun";
    let raw = if run {
        if v["status"] == "COMPLETED" {
            v["conclusion"].as_str().unwrap_or("")
        } else {
            v["status"].as_str().unwrap_or("")
        }
    } else {
        v["state"].as_str().unwrap_or("")
    };
    json!({"id":v["id"],"name":if run {&v["name"]} else {&v["context"]},"status":status(raw),"rawState":raw,"required":v["isRequired"],
        "url":if run {&v["detailsUrl"]} else {&v["targetUrl"]},"description":if run {&v["title"]} else {&v["description"]}})
}

fn normalize_review(v: &Value) -> Value {
    json!({"id":v["id"],"author":v["author"]["login"].as_str().unwrap_or("ghost"),"status":match v["state"].as_str().unwrap_or(""){"APPROVED"=>"approved","CHANGES_REQUESTED"=>"changes-requested","DISMISSED"=>"dismissed","PENDING"=>"pending",_=>"commented"},"body":v["body"],"submittedAt":v["submittedAt"],"url":v["url"]})
}

fn comment(v: &Value) -> Value {
    json!({"id":v["id"],"author":v["author"]["login"].as_str().unwrap_or("ghost"),"body":v["body"],"createdAt":v["createdAt"],"url":v["url"]})
}

fn activity(v: &Value, cursor: &Value, index: usize) -> Value {
    let kind = v["__typename"].as_str().unwrap_or("Activity");
    let actor = v["author"]["login"]
        .as_str()
        .or(v["actor"]["login"].as_str())
        .or(v["commit"]["author"]["user"]["login"].as_str())
        .or(v["commit"]["author"]["name"].as_str())
        .unwrap_or("");
    let description = match kind {
        "IssueComment" => "commented",
        "PullRequestReview" => match v["state"].as_str().unwrap_or("") {
            "APPROVED" => "approved",
            "CHANGES_REQUESTED" => "requested changes",
            _ => "reviewed",
        },
        "PullRequestCommit" => "committed",
        "MergedEvent" => "merged",
        "ClosedEvent" => "closed",
        "ReopenedEvent" => "reopened",
        "LabeledEvent" => "added a label",
        "UnlabeledEvent" => "removed a label",
        "AutoMergeEnabledEvent" => "enabled auto-merge",
        "AutoMergeDisabledEvent" => "disabled auto-merge",
        _ => "updated the pull request",
    };
    json!({"id":v["id"].as_str().map(str::to_owned).unwrap_or_else(||format!("{kind}:{cursor}:{index}")),"kind":kind,"author":actor,"text":description,"action":description,
        "body":v["body"].as_str().or(v["commit"]["messageHeadline"].as_str()).unwrap_or(""),"createdAt":v["createdAt"].as_str().or(v["submittedAt"].as_str()).or(v["commit"]["committedDate"].as_str()),
        "url":v["url"].as_str().or(v["commit"]["url"].as_str()),"label":v["label"],"sha":v["commit"]["oid"]})
}

fn draft_get(ctx: &Context, request: &Value) -> Result<Value> {
    let key = text(request, "key")?;
    Ok(json!({"draft":ctx.read("drafts",key)?,"attempt":ctx.read("review-attempts",key)?}))
}

fn draft_save(ctx: &Context, request: &Value) -> Result<Value> {
    let key = text(request, "key")?;
    let _guard = ctx.lock("drafts", key)?;
    if !request["draft"].is_object() {
        return Err(Error::new("INVALID_REQUEST", "Draft must be an object"));
    }
    let mut draft = ctx.read("drafts", key)?.unwrap_or_else(|| json!({}));
    let object = draft
        .as_object_mut()
        .ok_or_else(|| Error::new("INVALID_STATE", "Stored draft is not an object"))?;
    for (field, value) in request["draft"].as_object().unwrap() {
        object.insert(field.clone(), value.clone());
    }
    ctx.write("drafts", key, &draft)?;
    draft_get(ctx, request)
}

fn validate_submission(request: &Value) -> Result<()> {
    repository(request)?;
    number(request)?;
    text(request, "key")?;
    let oid = text(request, "headOid")?;
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::new("INVALID_REQUEST", "Invalid reviewed commit"));
    }
    if !matches!(
        text(request, "event")?,
        "COMMENT" | "APPROVE" | "REQUEST_CHANGES"
    ) {
        return Err(Error::new("INVALID_REQUEST", "Invalid review type"));
    }
    let body = request["body"].as_str().unwrap_or("");
    let threads = request["threads"]
        .as_array()
        .ok_or_else(|| Error::new("INVALID_REQUEST", "Review comments must be an array"))?;
    if request["event"] != "APPROVE" && body.trim().is_empty() && threads.is_empty() {
        return Err(Error::new(
            "EMPTY_REVIEW",
            "Add a summary or line comment before submitting",
        ));
    }
    if let Some(base) = request["baseOid"].as_str()
        && (!matches!(base.len(), 40 | 64) || !base.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(Error::new(
            "INVALID_REQUEST",
            "Invalid reviewed base commit",
        ));
    }
    for thread in threads {
        let path = text(thread, "path")?;
        if Path::new(path).is_absolute()
            || path.split('/').any(|p| p == "..")
            || path.contains('\0')
            || text(thread, "body")?.trim().is_empty()
            || !matches!(text(thread, "side")?, "LEFT" | "RIGHT")
            || thread["line"].as_u64().unwrap_or(0) == 0
        {
            return Err(Error::new("INVALID_COMMENT", "Invalid line comment anchor"));
        }
        let Some(start) = thread.get("startLine") else {
            continue;
        };
        if start.as_u64().unwrap_or(0) == 0
            || start.as_u64() > thread["line"].as_u64()
            || !matches!(text(thread, "startSide")?, "LEFT" | "RIGHT")
        {
            return Err(Error::new("INVALID_COMMENT", "Invalid line comment range"));
        }
    }
    Ok(())
}

fn pending_reviews(api: &mut impl Api, request: &Value, viewer: &str) -> Result<Vec<Value>> {
    let mut vars = variables(request)?;
    let mut found = Vec::new();
    loop {
        let data=api.query("query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(states:PENDING,first:$first,after:$after){nodes{id state body url commit{oid} author{login ... on Node{id}}} pageInfo{hasNextPage endCursor}}}}}",vars.clone(),false).map_err(|e|e.error)?;
        let c = &data["repository"]["pullRequest"]["reviews"];
        let page = connection(c, Value::clone)?;
        found.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["author"]["id"] == viewer)
                .cloned(),
        );
        if c["pageInfo"]["hasNextPage"] != true {
            break;
        }
        let next = c["pageInfo"]["endCursor"].clone();
        if next == vars["after"] {
            return Err(Error::new(
                "INCOMPLETE_RESPONSE",
                "GitHub repeated a review cursor",
            ));
        }
        vars["after"] = next;
    }
    Ok(found)
}

fn save_attempt(ctx: &Context, key: &str, attempt: &Value) -> Result<Value> {
    ctx.write("review-attempts", key, attempt)?;
    Ok(attempt.clone())
}

fn failure_value(error: &Error) -> Value {
    json!({"code":error.code,"message":error.message,"details":error.details})
}

fn submit(ctx: &Context, api: &mut impl Api, request: &Value) -> Result<Value> {
    validate_submission(request)?;
    let key = text(request, "key")?;
    let _guard = ctx.lock("review-attempts", key)?;
    let previous = ctx.read("review-attempts", key)?;
    if let Some(attempt) = &previous {
        if attempt["state"] == "confirmed" {
            return Ok(attempt.clone());
        }
        if matches!(
            attempt["state"].as_str(),
            Some("creating" | "sending" | "outcome-unknown")
        ) {
            return reconcile_attempt(ctx, api, key, attempt.clone());
        }
        if attempt["reviewId"].is_string()
            && (attempt["headOid"] != request["headOid"]
                || attempt["threads"] != request["threads"]
                || (attempt["baseOid"].is_string() && attempt["baseOid"] != request["baseOid"]))
        {
            return Err(Error::new(
                "PENDING_DRAFT_CHANGED",
                "A pending GitHub review already contains this draft. Reconcile it before changing its line comments.",
            ));
        }
    }
    if let Some(mut attempt) = previous.clone().filter(|a| a["reviewId"].is_string()) {
        let review = review_node(api, text(&attempt, "reviewId")?)?;
        if review["state"] == "PENDING" && review["body"] != attempt["body"] {
            return Err(Error::new(
                "REVIEW_DRAFT_MISMATCH",
                "The pending GitHub review summary changed. Inspect it on GitHub before continuing.",
            ));
        }
        apply_review(&mut attempt, &review)?;
        ctx.write("review-attempts", key, &attempt)?;
        if attempt["state"] == "confirmed" {
            return Ok(attempt);
        }
        if attempt["state"] != "pending" {
            return Err(Error::new(
                "REVIEW_OUTCOME_UNKNOWN",
                "Reconcile the saved GitHub review before submitting again",
            ));
        }
        verify_pending_comments(api, &attempt, &review)?;
    }
    let data = preflight(api, request)?;
    let pr = &data["repository"]["pullRequest"];
    if revision_changed(pr, request) {
        return Err(Error::new(
            "HEAD_CHANGED",
            "The pull request base or head changed. Update and review the new revision before submitting.",
        )
        .with_details(json!({"headOid":pr["headRefOid"],"baseOid":pr["baseRefOid"]})));
    }
    let viewer = text(&data["viewer"], "id")?;
    if previous
        .as_ref()
        .is_some_and(|a| a["reviewId"].is_string() && a["viewerId"] != viewer)
    {
        return Err(Error::new(
            "GITHUB_ACCOUNT_CHANGED",
            "This pending review belongs to another GitHub account. Switch back to that account to continue.",
        ));
    }
    if request["event"] != "COMMENT" && pr["author"]["id"] == viewer {
        return Err(Error::new(
            "SELF_REVIEW",
            "GitHub does not allow approving or requesting changes on your own pull request. Choose Comment.",
        ));
    }
    let mut attempt = previous.unwrap_or_else(|| json!({}));
    let pending = pending_reviews(api, request, viewer)?;
    let owned = attempt["reviewId"].as_str();
    if pending.iter().any(|r| r["id"].as_str() != owned) {
        return Err(Error::new("PENDING_REVIEW_EXISTS","You already have a pending review on GitHub. Finish or discard it there before submitting this draft.").with_details(json!({"url":pr["url"],"reviews":pending})));
    }
    attempt["repo"] = request["repo"].clone();
    attempt["number"] = request["number"].clone();
    attempt["headOid"] = request["headOid"].clone();
    attempt["baseOid"] = request["baseOid"].clone();
    attempt["body"] = json!(request["body"].as_str().unwrap_or(""));
    attempt["event"] = request["event"].clone();
    attempt["threads"] = request["threads"].clone();
    attempt["viewerId"] = json!(viewer);
    attempt["prId"] = pr["id"].clone();
    attempt["key"] = json!(key);
    attempt["error"] = Value::Null;
    if !attempt["reviewId"].is_string() {
        attempt["state"] = json!("creating");
        attempt["phase"] = json!("create");
        attempt["startedAt"] = json!(now());
        ctx.write("review-attempts", key, &attempt)?;
        let vars = json!({"input":{"pullRequestId":pr["id"],"commitOID":request["headOid"],"body":attempt["body"],"threads":request["threads"]}});
        let result=api.query("mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id state url commit{oid} author{... on Node{id}} pullRequest{id}}}}",vars,true);
        match result {
            Err(failure) => {
                attempt["state"] = json!(if failure.definite {
                    "editing"
                } else {
                    "outcome-unknown"
                });
                attempt["error"] = failure_value(&failure.error);
                return save_attempt(ctx, key, &attempt);
            }
            Ok(data) => {
                let review = &data["addPullRequestReview"]["pullRequestReview"];
                if !review["id"].is_string()
                    || review["state"] != "PENDING"
                    || review["commit"]["oid"] != attempt["headOid"]
                    || review["author"]["id"] != attempt["viewerId"]
                    || review["pullRequest"]["id"] != attempt["prId"]
                {
                    attempt["state"] = json!("outcome-unknown");
                    attempt["error"] = json!({"code":"INCOMPLETE_RESPONSE","message":"GitHub did not confirm the pending review. Reconcile before trying again."});
                    return save_attempt(ctx, key, &attempt);
                }
                attempt["reviewId"] = review["id"].clone();
                attempt["url"] = review["url"].clone();
                attempt["state"] = json!("pending");
                ctx.write("review-attempts", key, &attempt)?;
            }
        }
    }
    let current = preflight(api, request)?;
    if revision_changed(&current["repository"]["pullRequest"], &attempt) {
        attempt["state"] = json!("pending");
        attempt["error"] = json!({"code":"HEAD_CHANGED","message":"New commits arrived after the pending review was created. Your pending review is preserved on GitHub."});
        return save_attempt(ctx, key, &attempt);
    }
    attempt["state"] = json!("sending");
    attempt["phase"] = json!("submit");
    ctx.write("review-attempts", key, &attempt)?;
    let result=api.query("mutation($input:SubmitPullRequestReviewInput!){submitPullRequestReview(input:$input){pullRequestReview{id state url submittedAt commit{oid} author{... on Node{id}} pullRequest{id}}}}",json!({"input":{"pullRequestReviewId":attempt["reviewId"],"event":attempt["event"],"body":attempt["body"]}}),true);
    match result {
        Err(failure) => {
            attempt["state"] = json!(if failure.definite {
                "pending"
            } else {
                "outcome-unknown"
            });
            attempt["error"] = failure_value(&failure.error);
            save_attempt(ctx, key, &attempt)
        }
        Ok(data) => {
            let review = &data["submitPullRequestReview"]["pullRequestReview"];
            apply_review(&mut attempt, review)?;
            if attempt["state"] != "confirmed" {
                attempt["state"] = json!("outcome-unknown");
            }
            ctx.write("review-attempts", key, &attempt)?;
            if let Ok(current) = preflight(api, request) {
                attempt["outdated"] =
                    json!(current["repository"]["pullRequest"]["headRefOid"] != attempt["headOid"]);
            }
            save_attempt(ctx, key, &attempt)
        }
    }
}

fn apply_review(attempt: &mut Value, review: &Value) -> Result<()> {
    if review["id"] != attempt["reviewId"]
        || review["commit"]["oid"] != attempt["headOid"]
        || review["author"]["id"] != attempt["viewerId"]
        || review["pullRequest"]["id"] != attempt["prId"]
    {
        return Err(Error::new(
            "REVIEW_IDENTITY_MISMATCH",
            "GitHub returned a review for a different author, PR or revision. Submission remains blocked.",
        ));
    }
    let state = text(review, "state")?;
    attempt["state"] = json!(if state == "PENDING" {
        "pending"
    } else if matches!(
        state,
        "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"
    ) && review["submittedAt"].is_string()
    {
        "confirmed"
    } else {
        "outcome-unknown"
    });
    attempt["reviewState"] = json!(state);
    attempt["url"] = review["url"].clone();
    attempt["submittedAt"] = review["submittedAt"].clone();
    if attempt["state"] == "confirmed" {
        attempt["error"] = Value::Null;
    }
    Ok(())
}

fn review_node(api: &mut impl Api, id: &str) -> Result<Value> {
    let data=api.query("query($id:ID!){node(id:$id){... on PullRequestReview{id fullDatabaseId state url body submittedAt commit{oid} author{login ... on Node{id}} pullRequest{id}}}}",json!({"id":id}),false).map_err(|e|e.error)?;
    if data["node"].is_null() {
        return Err(Error::new(
            "REVIEW_NOT_FOUND",
            "GitHub cannot read the saved review. Submission remains blocked.",
        ));
    }
    Ok(data["node"].clone())
}

fn verify_pending_comments(api: &mut impl Api, attempt: &Value, review: &Value) -> Result<()> {
    let repo = repository(attempt)?;
    let database_id = review["fullDatabaseId"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| review["fullDatabaseId"].as_u64().map(|id| id.to_string()))
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| {
            Error::new(
                "INCOMPLETE_RESPONSE",
                "GitHub omitted the review's comment identifier",
            )
        })?;
    let threads = attempt["threads"]
        .as_array()
        .ok_or_else(|| Error::new("INVALID_DRAFT", "Saved review comments are missing"))?;
    let mut expected=threads.iter().map(|thread| json!({"path":thread["path"],"side":thread["side"],"line":thread["line"],"startLine":thread.get("startLine").unwrap_or(&thread["line"]),"startSide":thread.get("startSide").unwrap_or(&thread["side"]),"body":thread["body"]}).to_string()).collect::<Vec<_>>();
    let mut actual = Vec::new();
    let mut page = 1u64;
    loop {
        let path = format!(
            "repos/{}/{}/pulls/{}/reviews/{database_id}/comments?per_page={PAGE}&page={page}",
            text(repo, "owner")?,
            text(repo, "name")?,
            number(attempt)?
        );
        let response = api.rest(&path).map_err(|e| e.error)?;
        let comments = response.as_array().ok_or_else(|| {
            Error::new(
                "INCOMPLETE_RESPONSE",
                "GitHub omitted pending-review comments",
            )
        })?;
        for comment in comments {
            // The review collection returns legacy positions; the comment endpoint owns line and side anchors.
            let full = if !comment["side"].is_string() || !comment["original_line"].is_u64() {
                let id = comment["id"].as_u64().ok_or_else(|| {
                    Error::new(
                        "INCOMPLETE_RESPONSE",
                        "GitHub omitted a pending-review comment ID",
                    )
                })?;
                let item = api
                    .rest(&format!(
                        "repos/{}/{}/pulls/comments/{id}",
                        text(repo, "owner")?,
                        text(repo, "name")?
                    ))
                    .map_err(|e| e.error)?;
                if item["id"] != comment["id"] {
                    return Err(Error::new(
                        "INCOMPLETE_RESPONSE",
                        "GitHub returned a different review comment",
                    ));
                }
                Some(item)
            } else {
                None
            };
            let comment = full.as_ref().unwrap_or(comment);
            let review_id = comment["pull_request_review_id"]
                .as_u64()
                .map(|id| id.to_string())
                .or_else(|| {
                    comment["pull_request_review_id"]
                        .as_str()
                        .map(str::to_owned)
                });
            if review_id.as_deref() != Some(database_id.as_str()) {
                return Err(Error::new(
                    "REVIEW_COMMENTS_CHANGED",
                    "GitHub returned a comment attached to another review",
                ));
            }
            if comment["original_commit_id"] != attempt["headOid"]
                || comment["commit_id"] != attempt["headOid"]
                || !comment["in_reply_to_id"].is_null()
            {
                return Err(Error::new(
                    "REVIEW_COMMENTS_CHANGED",
                    "The GitHub review contains comments on another revision or thread. Inspect it on GitHub before continuing.",
                ));
            }
            let line = comment["original_line"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    Error::new(
                        "REVIEW_COMMENTS_CHANGED",
                        "The GitHub review contains an unsupported or changed line comment",
                    )
                })?;
            let side = comment["side"].as_str().ok_or_else(|| {
                Error::new(
                    "INCOMPLETE_RESPONSE",
                    "GitHub omitted a review comment side",
                )
            })?;
            if !matches!(side, "LEFT" | "RIGHT")
                || !comment["body"].is_string()
                || !comment["path"].is_string()
            {
                return Err(Error::new(
                    "INCOMPLETE_RESPONSE",
                    "GitHub omitted a review comment anchor",
                ));
            }
            let start = comment["original_start_line"].as_u64().unwrap_or(line);
            let start_side = comment["start_side"].as_str().unwrap_or(side);
            actual.push(json!({"path":comment["path"],"side":side,"line":line,"startLine":start,"startSide":start_side,"body":comment["body"]}).to_string());
        }
        if comments.len() < (PAGE as usize) {
            break;
        }
        page += 1;
    }
    expected.sort_unstable();
    actual.sort_unstable();
    if expected != actual {
        return Err(Error::new(
            "REVIEW_COMMENTS_CHANGED",
            "The pending GitHub review's line comments differ from this draft. It was not adopted or published. Inspect the review on GitHub.",
        ));
    }
    Ok(())
}

fn reconcile_attempt(
    ctx: &Context,
    api: &mut impl Api,
    key: &str,
    mut attempt: Value,
) -> Result<Value> {
    if attempt["state"] == "confirmed" {
        return Ok(attempt);
    }
    if let Some(id) = attempt["reviewId"].as_str() {
        let review = review_node(api, id)?;
        apply_review(&mut attempt, &review)?;
        attempt["reconciledAt"] = json!(now());
    } else {
        let viewer = text(&attempt, "viewerId")?;
        let current = preflight(api, &attempt)?;
        if current["viewer"]["id"] != viewer {
            return Err(Error::new(
                "GITHUB_ACCOUNT_CHANGED",
                "Switch back to the GitHub account that started this review before reconciling it",
            ));
        }
        let candidates = pending_reviews(api, &attempt, viewer)?;
        attempt["state"] = json!("outcome-unknown");
        attempt["candidates"] = json!(candidates);
        attempt["reconciledAt"] = json!(now());
        attempt["error"] = json!({"code":"CREATE_OUTCOME_UNKNOWN","message":"The pending review's creation could not be confirmed. Inspect GitHub and adopt the matching pending review, or explicitly acknowledge the risk before starting another attempt."});
    }
    save_attempt(ctx, key, &attempt)
}

fn reconcile(ctx: &Context, api: &mut impl Api, request: &Value) -> Result<Value> {
    let key = text(request, "key")?;
    let _guard = ctx.lock("review-attempts", key)?;
    let attempt = ctx
        .read("review-attempts", key)?
        .ok_or_else(|| Error::new("NO_REVIEW_ATTEMPT", "No review submission to reconcile"))?;
    reconcile_attempt(ctx, api, key, attempt)
}

fn adopt(ctx: &Context, api: &mut impl Api, request: &Value) -> Result<Value> {
    let key = text(request, "key")?;
    let _guard = ctx.lock("review-attempts", key)?;
    let mut attempt = ctx.read("review-attempts", key)?.ok_or_else(|| {
        Error::new(
            "NO_REVIEW_ATTEMPT",
            "No uncertain review creation to reconcile",
        )
    })?;
    if attempt["phase"] != "create"
        || attempt["reviewId"].is_string()
        || !matches!(
            attempt["state"].as_str(),
            Some("creating" | "outcome-unknown")
        )
    {
        return Err(Error::new(
            "ADOPTION_NOT_ALLOWED",
            "Only an uncertain pending-review creation can be adopted",
        ));
    }
    let id = text(request, "reviewId")?;
    let review = review_node(api, id)?;
    if review["body"] != attempt["body"] {
        return Err(Error::new(
            "REVIEW_DRAFT_MISMATCH",
            "This GitHub review has a different summary. It was not adopted.",
        ));
    }
    attempt["reviewId"] = json!(id);
    apply_review(&mut attempt, &review)?;
    verify_pending_comments(api, &attempt, &review)?;
    attempt["reconciledAt"] = json!(now());
    save_attempt(ctx, key, &attempt)
}

fn restart(ctx: &Context, api: &mut impl Api, request: &Value) -> Result<Value> {
    let key = text(request, "key")?;
    let _guard = ctx.lock("review-attempts", key)?;
    let attempt = ctx
        .read("review-attempts", key)?
        .ok_or_else(|| Error::new("NO_REVIEW_ATTEMPT", "No uncertain creation to restart"))?;
    if attempt["state"] != "outcome-unknown"
        || attempt["phase"] != "create"
        || attempt["reviewId"].is_string()
        || !attempt["reconciledAt"].is_u64()
    {
        return Err(Error::new(
            "RESTART_NOT_ALLOWED",
            "Only a reconciled, uncertain review creation without a known review ID can be restarted",
        ));
    }
    if request["acknowledgeRisk"] != true || request["githubInspected"] != true {
        return Err(Error::new(
            "RESTART_ACKNOWLEDGMENT_REQUIRED",
            "Inspect GitHub and acknowledge that an earlier request could still create a review before starting another attempt",
        ));
    }
    let current = preflight(api, &attempt)?;
    let viewer = text(&attempt, "viewerId")?;
    if current["viewer"]["id"] != viewer {
        return Err(Error::new(
            "GITHUB_ACCOUNT_CHANGED",
            "Switch back to the GitHub account that started this review before restarting it",
        ));
    }
    let pending = pending_reviews(api, &attempt, viewer)?;
    if !pending.is_empty() {
        return Err(Error::new("PENDING_REVIEW_EXISTS","A pending review is now visible on GitHub. Reconcile it before starting another attempt.").with_details(json!({"reviews":pending})));
    }
    let archive = format!("{key}-{}-{}", now(), request_serial());
    ctx.write("review-audit", &archive, &attempt)?;
    save_attempt(
        ctx,
        key,
        &json!({"state":"editing","key":key,"restartedAt":now(),"previousAttempt":archive}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Fixture {
        replies: VecDeque<std::result::Result<Value, ApiFailure>>,
        calls: Vec<(String, Value, bool)>,
        rest_replies: VecDeque<Value>,
        rest_calls: Vec<String>,
    }
    impl Fixture {
        fn new(replies: Vec<std::result::Result<Value, ApiFailure>>) -> Self {
            Self {
                replies: replies.into(),
                calls: Vec::new(),
                rest_replies: VecDeque::new(),
                rest_calls: Vec::new(),
            }
        }
        fn with_rest(mut self, replies: Vec<Value>) -> Self {
            self.rest_replies = replies.into();
            self
        }
        fn mutations(&self) -> Vec<&(String, Value, bool)> {
            self.calls.iter().filter(|c| c.2).collect()
        }
    }
    impl Api for Fixture {
        fn rest(&mut self, path: &str) -> std::result::Result<Value, ApiFailure> {
            self.rest_calls.push(path.into());
            Ok(self
                .rest_replies
                .pop_front()
                .expect("unexpected GitHub REST request"))
        }
        fn query(
            &mut self,
            query: &str,
            variables: Value,
            mutation: bool,
        ) -> std::result::Result<Value, ApiFailure> {
            self.calls.push((query.to_owned(), variables, mutation));
            self.replies.pop_front().expect("unexpected GitHub request")
        }
    }
    struct State(Context);
    impl State {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "herdr-pr-gh-test-{}-{}-{}",
                std::process::id(),
                now(),
                request_serial()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(Context { root })
        }
    }
    impl Drop for State {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.root);
        }
    }
    fn request() -> Value {
        json!({"op":"review.submit","key":"draft-one","repo":{"host":"github.com","owner":"example","name":"repo"},"number":42,"headOid":"a".repeat(40),"body":"Looks good","event":"APPROVE","threads":[]})
    }
    fn pr_data(head: &str) -> Value {
        json!({"viewer":{"id":"U1","login":"reviewer"},"repository":{"pullRequest":{"id":"PR1","number":42,"headRefOid":head,"url":"https://github.com/example/repo/pull/42"}}})
    }
    fn review(state: &str) -> Value {
        json!({"id":"R1","fullDatabaseId":"12345","state":state,"url":"https://github.com/example/repo/pull/42#pullrequestreview-R1","body":"Looks good","commit":{"oid":"a".repeat(40)},"author":{"id":"U1"},"pullRequest":{"id":"PR1"},"submittedAt":if state=="PENDING"{Value::Null}else{json!("2026-11-12T10:00:00Z")}})
    }
    fn pending(reviews: Vec<Value>) -> Value {
        json!({"repository":{"pullRequest":{"reviews":{"nodes":reviews,"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})
    }
    fn lost() -> std::result::Result<Value, ApiFailure> {
        Err(ApiFailure {
            error: Error::new("TIMEOUT", "response lost"),
            definite: false,
        })
    }

    #[test]
    fn publishes_known_pending_id_once_and_preserves_receipt_across_repeated_submit() {
        let state = State::new();
        let request = request();
        let pr = pr_data(request["headOid"].as_str().unwrap());
        let mut api = Fixture::new(vec![
            Ok(pr.clone()),
            Ok(pending(vec![])),
            Ok(json!({"addPullRequestReview":{"pullRequestReview":review("PENDING")}})),
            Ok(pr.clone()),
            Ok(json!({"submitPullRequestReview":{"pullRequestReview":review("APPROVED")}})),
            Ok(pr),
        ]);
        let result = submit(&state.0, &mut api, &request).unwrap();
        assert_eq!(result["state"], "confirmed");
        let calls = api.calls.len();
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap()["reviewId"],
            "R1"
        );
        assert_eq!(api.calls.len(), calls);
        let mutations = api.mutations();
        assert_eq!(mutations.len(), 2);
        assert!(mutations[0].1["input"].get("event").is_none());
        assert_eq!(mutations[0].1["input"]["commitOID"], request["headOid"]);
        assert_eq!(mutations[1].1["input"]["pullRequestReviewId"], "R1");
        assert!(mutations[1].1["input"].get("pullRequestId").is_none());
    }

    #[test]
    fn lost_submit_response_reconciles_saved_review_without_creating_or_sending_again() {
        let state = State::new();
        let request = request();
        let pr = pr_data(request["headOid"].as_str().unwrap());
        let mut api = Fixture::new(vec![
            Ok(pr.clone()),
            Ok(pending(vec![])),
            Ok(json!({"addPullRequestReview":{"pullRequestReview":review("PENDING")}})),
            Ok(pr),
            lost(),
            Ok(json!({"node":review("APPROVED")})),
        ]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap()["state"],
            "outcome-unknown"
        );
        assert_eq!(
            state
                .0
                .read("review-attempts", "draft-one")
                .unwrap()
                .unwrap()["reviewId"],
            "R1"
        );
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap()["state"],
            "confirmed"
        );
        assert_eq!(api.mutations().len(), 2);
    }

    #[test]
    fn uncertain_create_is_blocked_until_explicit_verified_adoption() {
        let state = State::new();
        let request = request();
        let pr = pr_data(request["headOid"].as_str().unwrap());
        let mut api = Fixture::new(vec![
            Ok(pr.clone()),
            Ok(pending(vec![])),
            lost(),
            Ok(pr),
            Ok(pending(vec![review("PENDING")])),
            Ok(json!({"node":review("PENDING")})),
        ])
        .with_rest(vec![json!([])]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap()["state"],
            "outcome-unknown"
        );
        let blocked = submit(&state.0, &mut api, &request).unwrap();
        assert_eq!(blocked["state"], "outcome-unknown");
        assert_eq!(blocked["candidates"][0]["id"], "R1");
        assert_eq!(api.mutations().len(), 1);
        let adopted = adopt(
            &state.0,
            &mut api,
            &json!({"key":"draft-one","reviewId":"R1"}),
        )
        .unwrap();
        assert_eq!(adopted["state"], "pending");
        assert_eq!(api.mutations().len(), 1);
    }

    #[test]
    fn stale_head_and_existing_unowned_pending_review_never_publish() {
        let state = State::new();
        let request = request();
        let mut stale = Fixture::new(vec![Ok(pr_data(&"b".repeat(40)))]);
        assert_eq!(
            submit(&state.0, &mut stale, &request).unwrap_err().code,
            "HEAD_CHANGED"
        );
        assert!(stale.mutations().is_empty());
        let mut occupied = Fixture::new(vec![
            Ok(pr_data(request["headOid"].as_str().unwrap())),
            Ok(pending(vec![review("PENDING")])),
        ]);
        assert_eq!(
            submit(&state.0, &mut occupied, &request).unwrap_err().code,
            "PENDING_REVIEW_EXISTS"
        );
        assert!(occupied.mutations().is_empty());
    }

    #[test]
    fn pending_retry_reads_saved_review_state_before_any_further_write() {
        let state = State::new();
        let request = request();
        let mut attempt = request.clone();
        attempt["state"] = json!("pending");
        attempt["reviewId"] = json!("R1");
        attempt["viewerId"] = json!("U1");
        attempt["prId"] = json!("PR1");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        let mut api = Fixture::new(vec![Ok(json!({"node":review("APPROVED")}))]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap()["state"],
            "confirmed"
        );
        assert_eq!(api.calls.len(), 1);
        assert!(api.mutations().is_empty());
    }

    #[test]
    fn changed_account_and_self_approval_never_create_pending_reviews() {
        let state = State::new();
        let request = request();
        let mut attempt = request.clone();
        attempt["state"] = json!("pending");
        attempt["reviewId"] = json!("R1");
        attempt["viewerId"] = json!("U1");
        attempt["prId"] = json!("PR1");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        let mut current = pr_data(request["headOid"].as_str().unwrap());
        current["viewer"]["id"] = json!("U2");
        let mut api = Fixture::new(vec![Ok(json!({"node":review("PENDING")})), Ok(current)])
            .with_rest(vec![json!([])]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap_err().code,
            "GITHUB_ACCOUNT_CHANGED"
        );
        assert!(api.mutations().is_empty());
        let clean = State::new();
        let mut own = pr_data(request["headOid"].as_str().unwrap());
        own["repository"]["pullRequest"]["author"]["id"] = json!("U1");
        let mut api = Fixture::new(vec![Ok(own)]);
        assert_eq!(
            submit(&clean.0, &mut api, &request).unwrap_err().code,
            "SELF_REVIEW"
        );
        assert!(api.mutations().is_empty());
    }

    #[test]
    fn review_identity_mismatch_cannot_be_adopted() {
        let state = State::new();
        let request = request();
        let pr = pr_data(request["headOid"].as_str().unwrap());
        let mut wrong = review("PENDING");
        wrong["author"]["id"] = json!("OTHER");
        let mut api = Fixture::new(vec![
            Ok(pr),
            Ok(pending(vec![])),
            lost(),
            Ok(json!({"node":wrong})),
        ]);
        submit(&state.0, &mut api, &request).unwrap();
        assert_eq!(
            adopt(
                &state.0,
                &mut api,
                &json!({"key":"draft-one","reviewId":"R1"})
            )
            .unwrap_err()
            .code,
            "REVIEW_IDENTITY_MISMATCH"
        );
        assert!(
            !state
                .0
                .read("review-attempts", "draft-one")
                .unwrap()
                .unwrap()["reviewId"]
                .is_string()
        );
    }

    #[test]
    fn collection_cursor_is_forwarded_and_partial_data_is_never_success() {
        let request = json!({"op":"github.list","repo":{"host":"github.com","owner":"example","name":"repo"},"cursor":"page-two"});
        let mut api = Fixture::new(vec![Ok(
            json!({"repository":{"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":"page-three"}}}}),
        )]);
        let result = read_operation(&mut api, &request).unwrap();
        assert_eq!(result["pageInfo"]["endCursor"], "page-three");
        assert_eq!(api.calls[0].1["after"], "page-two");
        assert!(decode_response(0,r#"{"data":{"repository":null},"errors":[{"message":"denied","type":"FORBIDDEN"}]}"#,"",false).is_err());
        assert!(
            connection(
                &json!({"nodes":[],"pageInfo":{"hasNextPage":true}}),
                Value::clone
            )
            .is_err()
        );
    }

    #[test]
    fn mixed_check_counts_and_current_review_opinions_preserve_meaning() {
        let pr = json!({"state":"OPEN","isDraft":false,"mergeQueueEntry":{"position":2},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"PENDING","contexts":{"totalCount":7,"checkRunCountsByState":[{"state":"SUCCESS","count":2},{"state":"IN_PROGRESS","count":1},{"state":"SKIPPED","count":1}],"statusContextCountsByState":[{"state":"SUCCESS","count":1},{"state":"FAILURE","count":1},{"state":"PENDING","count":1}]}}}}]}});
        let normalized = normalize_pr(&pr);
        assert_eq!(normalized["state"], "In queue");
        assert_eq!(normalized["checksSummary"]["passed"], 3);
        assert_eq!(normalized["checksSummary"]["failed"], 1);
        assert_eq!(normalized["checksSummary"]["running"], 1);
        assert_eq!(normalized["checksSummary"]["waiting"], 1);
        assert_eq!(normalized["checksSummary"]["skipped"], 1);
        assert_eq!(
            normalize_review(&json!({"state":"DISMISSED"}))["status"],
            "dismissed"
        );
        assert_eq!(
            normalize_check(
                &json!({"__typename":"CheckRun","status":"COMPLETED","conclusion":"NEUTRAL"})
            )["status"],
            "neutral"
        );
    }

    #[test]
    fn origin_identity_never_exposes_embedded_credentials_or_guesses_other_hosts() {
        let (_, _, url) = remote_identity("https://user:secret@github.com/Owner/Repo.git").unwrap();
        assert_eq!(url, "https://github.com/Owner/Repo.git");
        assert!(remote_identity("git@example.com:Owner/Repo.git").is_err());
    }

    #[test]
    fn durable_draft_updates_do_not_erase_attempt_receipts() {
        let state = State::new();
        state
            .0
            .write(
                "review-attempts",
                "a",
                &json!({"state":"confirmed","reviewId":"R1"}),
            )
            .unwrap();
        let saved = draft_save(&state.0, &json!({"key":"a","draft":{"body":"new text"}})).unwrap();
        assert_eq!(saved["draft"]["body"], "new text");
        assert_eq!(saved["attempt"]["reviewId"], "R1");
    }

    fn saved_attempt(request: &Value, state: &str) -> Value {
        let mut attempt = request.clone();
        attempt["state"] = json!(state);
        attempt["phase"] = json!("create");
        attempt["viewerId"] = json!("U1");
        attempt["prId"] = json!("PR1");
        attempt
    }

    fn thread(line: u64) -> Value {
        json!({"path":"src/main.rs","side":"RIGHT","line":line,"body":format!("Note {line}")})
    }
    fn remote_comment(thread: &Value) -> Value {
        json!({"id":thread["line"],"pull_request_review_id":12345,"path":thread["path"],"side":thread["side"],"original_line":thread["line"],"original_start_line":thread["startLine"],"start_side":thread["startSide"],"body":thread["body"],"commit_id":"a".repeat(40),"original_commit_id":"a".repeat(40),"in_reply_to_id":null})
    }

    #[test]
    fn legacy_review_collection_is_completed_with_exact_comment_endpoint_anchors() {
        let request = request();
        let mut attempt = saved_attempt(&request, "pending");
        attempt["threads"] = json!([thread(1)]);
        let mut api = Fixture::new(vec![]).with_rest(vec![
            json!([{"id":1,"position":4,"original_position":4}]),
            remote_comment(&thread(1)),
        ]);
        verify_pending_comments(&mut api, &attempt, &review("PENDING")).unwrap();
        assert_eq!(api.rest_calls.len(), 2);
        assert_eq!(api.rest_calls[1], "repos/example/repo/pulls/comments/1");
    }

    #[test]
    fn adoption_rejects_unrelated_comments_even_with_identical_empty_summary_and_identity() {
        let state = State::new();
        let mut request = request();
        request["body"] = json!("");
        request["threads"] = json!([thread(1)]);
        state
            .0
            .write(
                "review-attempts",
                "draft-one",
                &saved_attempt(&request, "outcome-unknown"),
            )
            .unwrap();
        let mut pending = review("PENDING");
        pending["body"] = json!("");
        let mut api = Fixture::new(vec![Ok(json!({"node":pending}))])
            .with_rest(vec![json!([remote_comment(&thread(99))])]);
        assert_eq!(
            adopt(
                &state.0,
                &mut api,
                &json!({"key":"draft-one","reviewId":"R1"})
            )
            .unwrap_err()
            .code,
            "REVIEW_COMMENTS_CHANGED"
        );
        assert!(
            !state
                .0
                .read("review-attempts", "draft-one")
                .unwrap()
                .unwrap()["reviewId"]
                .is_string()
        );
        assert!(api.mutations().is_empty());
    }

    #[test]
    fn known_pending_review_cannot_publish_after_comment_was_edited_on_github() {
        let state = State::new();
        let mut request = request();
        request["threads"] = json!([thread(1)]);
        let mut attempt = saved_attempt(&request, "pending");
        attempt["reviewId"] = json!("R1");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        let mut changed = remote_comment(&thread(1));
        changed["body"] = json!("Edited on GitHub");
        let mut api = Fixture::new(vec![Ok(json!({"node":review("PENDING")}))])
            .with_rest(vec![json!([changed])]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap_err().code,
            "REVIEW_COMMENTS_CHANGED"
        );
        assert_eq!(api.rest_calls.len(), 1);
        assert!(api.mutations().is_empty());
    }

    #[test]
    fn known_pending_review_cannot_overwrite_a_summary_edited_on_github() {
        let state = State::new();
        let request = request();
        let mut attempt = saved_attempt(&request, "pending");
        attempt["reviewId"] = json!("R1");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        let mut pending = review("PENDING");
        pending["body"] = json!("Changed on GitHub");
        let mut api = Fixture::new(vec![Ok(json!({"node":pending}))]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap_err().code,
            "REVIEW_DRAFT_MISMATCH"
        );
        assert!(api.mutations().is_empty());
    }

    #[test]
    fn comment_verification_checks_later_pages_and_original_side_range_and_commit() {
        let state = State::new();
        let mut request = request();
        let comments = (1..=26).map(thread).collect::<Vec<_>>();
        request["threads"] = json!(comments);
        let attempt = saved_attempt(&request, "outcome-unknown");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        let first = comments[..25]
            .iter()
            .map(remote_comment)
            .collect::<Vec<_>>();
        let mut last = remote_comment(&comments[25]);
        last["side"] = json!("LEFT");
        let mut api = Fixture::new(vec![Ok(json!({"node":review("PENDING")}))])
            .with_rest(vec![json!(first), json!([last])]);
        assert_eq!(
            adopt(
                &state.0,
                &mut api,
                &json!({"key":"draft-one","reviewId":"R1"})
            )
            .unwrap_err()
            .code,
            "REVIEW_COMMENTS_CHANGED"
        );
        assert!(api.rest_calls[0].ends_with("page=1"));
        assert!(api.rest_calls[1].ends_with("page=2"));
        assert!(api.mutations().is_empty());

        let range = json!({"path":"renamed file.rs","side":"LEFT","line":9,"startLine":7,"startSide":"LEFT","body":"Check the old range"});
        let mut expected = attempt;
        expected["threads"] = json!([range]);
        let mut api = Fixture::new(vec![]).with_rest(vec![json!([remote_comment(&range)])]);
        verify_pending_comments(&mut api, &expected, &review("PENDING")).unwrap();
        let mut wrong = remote_comment(&range);
        wrong["original_start_line"] = json!(8);
        let mut api = Fixture::new(vec![]).with_rest(vec![json!([wrong])]);
        assert_eq!(
            verify_pending_comments(&mut api, &expected, &review("PENDING"))
                .unwrap_err()
                .code,
            "REVIEW_COMMENTS_CHANGED"
        );
        let mut wrong = remote_comment(&range);
        wrong["original_commit_id"] = json!("b".repeat(40));
        let mut api = Fixture::new(vec![]).with_rest(vec![json!([wrong])]);
        assert_eq!(
            verify_pending_comments(&mut api, &expected, &review("PENDING"))
                .unwrap_err()
                .code,
            "REVIEW_COMMENTS_CHANGED"
        );
    }

    #[test]
    fn unknown_creation_can_restart_only_after_reconciliation_and_explicit_risk_acknowledgment() {
        let state = State::new();
        let request = request();
        let attempt = saved_attempt(&request, "outcome-unknown");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        state
            .0
            .write("drafts", "draft-one", &json!({"body":"Keep my draft"}))
            .unwrap();
        let acknowledged = json!({"key":"draft-one","acknowledgeRisk":true,"githubInspected":true});
        let pr = pr_data(request["headOid"].as_str().unwrap());
        let mut api = Fixture::new(vec![
            Ok(pr.clone()),
            Ok(pending(vec![])),
            Ok(pr),
            Ok(pending(vec![])),
        ]);
        assert_eq!(
            restart(&state.0, &mut api, &acknowledged).unwrap_err().code,
            "RESTART_NOT_ALLOWED"
        );
        let reconciled = reconcile(&state.0, &mut api, &json!({"key":"draft-one"})).unwrap();
        assert!(reconciled["reconciledAt"].is_u64());
        assert_eq!(
            restart(&state.0, &mut api, &json!({"key":"draft-one"}))
                .unwrap_err()
                .code,
            "RESTART_ACKNOWLEDGMENT_REQUIRED"
        );
        let restarted = restart(&state.0, &mut api, &acknowledged).unwrap();
        assert_eq!(restarted["state"], "editing");
        assert!(api.mutations().is_empty());
        assert_eq!(
            state
                .0
                .read(
                    "review-audit",
                    restarted["previousAttempt"].as_str().unwrap()
                )
                .unwrap()
                .unwrap()["state"],
            "outcome-unknown"
        );
        assert_eq!(
            state.0.read("drafts", "draft-one").unwrap().unwrap()["body"],
            "Keep my draft"
        );
    }

    #[test]
    fn restart_refuses_receipts_inflight_attempts_and_a_newly_visible_pending_review() {
        let state = State::new();
        let request = request();
        let acknowledged = json!({"key":"draft-one","acknowledgeRisk":true,"githubInspected":true});
        for state_name in ["creating", "sending", "confirmed", "pending"] {
            let mut attempt = saved_attempt(&request, state_name);
            attempt["reconciledAt"] = json!(now());
            state
                .0
                .write("review-attempts", "draft-one", &attempt)
                .unwrap();
            assert_eq!(
                restart(&state.0, &mut Fixture::new(vec![]), &acknowledged)
                    .unwrap_err()
                    .code,
                "RESTART_NOT_ALLOWED"
            );
        }
        let mut attempt = saved_attempt(&request, "outcome-unknown");
        attempt["reconciledAt"] = json!(now());
        attempt["reviewId"] = json!("R1");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        assert_eq!(
            restart(&state.0, &mut Fixture::new(vec![]), &acknowledged)
                .unwrap_err()
                .code,
            "RESTART_NOT_ALLOWED"
        );
        attempt.as_object_mut().unwrap().remove("reviewId");
        state
            .0
            .write("review-attempts", "draft-one", &attempt)
            .unwrap();
        let mut api = Fixture::new(vec![
            Ok(pr_data(request["headOid"].as_str().unwrap())),
            Ok(pending(vec![review("PENDING")])),
        ]);
        assert_eq!(
            restart(&state.0, &mut api, &acknowledged).unwrap_err().code,
            "PENDING_REVIEW_EXISTS"
        );
        assert!(api.mutations().is_empty());
        assert_eq!(
            state
                .0
                .read("review-attempts", "draft-one")
                .unwrap()
                .unwrap()["state"],
            "outcome-unknown"
        );
    }

    #[test]
    fn known_base_change_is_rejected_before_pending_review_creation() {
        let state = State::new();
        let mut request = request();
        request["baseOid"] = json!("b".repeat(40));
        let mut pr = pr_data(request["headOid"].as_str().unwrap());
        pr["repository"]["pullRequest"]["baseRefOid"] = json!("c".repeat(40));
        let mut api = Fixture::new(vec![Ok(pr)]);
        assert_eq!(
            submit(&state.0, &mut api, &request).unwrap_err().code,
            "HEAD_CHANGED"
        );
        assert!(api.mutations().is_empty());
    }
}
