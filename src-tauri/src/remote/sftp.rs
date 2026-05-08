use super::*;

pub(super) async fn search_remote_file_with_find(
    handle: &SshHandle,
    base_path: &str,
    keyword: &str,
) -> AppResult<Option<String>> {
    let command = build_remote_find_command(base_path, keyword);
    let result = exec_with_handle(handle, command, SFTP_REMOTE_SEARCH_TIMEOUT_MS).await?;
    if result.timed_out {
        return Ok(None);
    }
    Ok(result
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(normalize_remote_path))
}

pub(super) fn build_remote_find_command(base_path: &str, keyword: &str) -> String {
    let pattern = format!("*{keyword}*");
    format!(
        "command -v find >/dev/null 2>&1 && find {} -iname {} -print -quit 2>/dev/null",
        shell_quote(&normalize_remote_path(base_path)),
        shell_quote(&pattern)
    )
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) async fn create_remote_dir_all(sftp: &SftpSession, path: &str) -> AppResult<()> {
    let normalized = normalize_remote_path(path);
    if normalized == "/" {
        return Ok(());
    }
    let mut current = String::new();
    for part in normalized.split('/').filter(|part| !part.is_empty()) {
        current.push('/');
        current.push_str(part);
        match sftp
            .try_exists(current.clone())
            .await
            .map_err(remote_error)?
        {
            true => {
                let metadata = sftp
                    .symlink_metadata(current.clone())
                    .await
                    .map_err(remote_error)?;
                if !metadata.file_type().is_dir() {
                    return Err(AppError::InvalidInput(format!("{current} 不是目录")));
                }
            }
            false => sftp
                .create_dir(current.clone())
                .await
                .map_err(remote_error)?,
        }
    }
    Ok(())
}

pub(super) async fn copy_remote_path(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    let source = normalize_remote_path(from);
    let target = normalize_remote_path(to);
    let metadata = sftp
        .symlink_metadata(source.clone())
        .await
        .map_err(remote_error)?;
    if !metadata.file_type().is_dir() {
        return copy_remote_file(sftp, &source, &target).await;
    }

    create_remote_dir_all(sftp, &target).await?;
    let mut dirs = vec![(source, target)];
    let mut index = 0;
    while index < dirs.len() {
        let (current_source, current_target) = dirs[index].clone();
        index += 1;
        let entries = sftp
            .read_dir(current_source.clone())
            .await
            .map_err(remote_error)?;
        for entry in entries {
            let child_source = join_remote_path(&current_source, &entry.file_name());
            let child_target = join_remote_path(&current_target, &entry.file_name());
            if entry.file_type().is_dir() {
                create_remote_dir_all(sftp, &child_target).await?;
                dirs.push((child_source, child_target));
            } else {
                copy_remote_file(sftp, &child_source, &child_target).await?;
            }
        }
    }
    Ok(())
}

pub(super) async fn copy_remote_file(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    let mut source = sftp.open(from.to_string()).await.map_err(remote_error)?;
    let mut target = sftp
        .open_with_flags(
            to.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(remote_error)?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = source.read(&mut buffer).await.map_err(remote_error)?;
        if read == 0 {
            break;
        }
        target
            .write_all(&buffer[..read])
            .await
            .map_err(remote_error)?;
    }
    target.flush().await.map_err(remote_error)?;
    Ok(())
}

pub(super) async fn delete_remote_path(
    sftp: &SftpSession,
    path: &str,
    recursive: bool,
) -> AppResult<()> {
    let path = normalize_remote_path(path);
    let metadata = sftp
        .symlink_metadata(path.clone())
        .await
        .map_err(remote_error)?;
    if !metadata.file_type().is_dir() {
        return sftp.remove_file(path).await.map_err(remote_error);
    }
    if !recursive {
        return sftp.remove_dir(path).await.map_err(remote_error);
    }

    let mut dirs = vec![path];
    let mut index = 0;
    while index < dirs.len() {
        let current = dirs[index].clone();
        index += 1;
        let entries = sftp.read_dir(current.clone()).await.map_err(remote_error)?;
        for entry in entries {
            let child = join_remote_path(&current, &entry.file_name());
            if entry.file_type().is_dir() {
                dirs.push(child);
            } else {
                sftp.remove_file(child).await.map_err(remote_error)?;
            }
        }
    }
    for dir in dirs.into_iter().rev() {
        sftp.remove_dir(dir).await.map_err(remote_error)?;
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct OwnerLookup {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

pub(super) async fn resolve_owner_lookup(
    handle: &SshHandle,
    entries: &[DirEntry],
) -> AppResult<OwnerLookup> {
    let mut uids = HashSet::new();
    let mut gids = HashSet::new();
    for entry in entries {
        let metadata = entry.metadata();
        if metadata.user.is_none() {
            if let Some(uid) = metadata.uid {
                uids.insert(uid);
            }
        }
        if metadata.group.is_none() {
            if let Some(gid) = metadata.gid {
                gids.insert(gid);
            }
        }
    }
    if uids.is_empty() && gids.is_empty() {
        return Ok(OwnerLookup::default());
    }

    let user_args = join_numbers(uids);
    let group_args = join_numbers(gids);
    let command = format!(
        "sh -lc '{}{}'",
        if user_args.is_empty() {
            String::new()
        } else {
            format!("getent passwd {user_args} | awk -F: '\\''{{print \"u:\"$3\":\"$1}}'\\''; ")
        },
        if group_args.is_empty() {
            String::new()
        } else {
            format!("getent group {group_args} | awk -F: '\\''{{print \"g:\"$3\":\"$1}}'\\''")
        }
    );
    let result = exec_with_handle(handle, command, SFTP_OWNER_LOOKUP_TIMEOUT_MS).await?;
    let mut lookup = OwnerLookup::default();
    for line in result.stdout.lines() {
        let mut parts = line.splitn(3, ':');
        let kind = parts.next();
        let id = parts.next().and_then(|value| value.parse::<u32>().ok());
        let name = parts.next().filter(|value| !value.is_empty());
        match (kind, id, name) {
            (Some("u"), Some(id), Some(name)) => {
                lookup.users.insert(id, name.to_string());
            }
            (Some("g"), Some(id), Some(name)) => {
                lookup.groups.insert(id, name.to_string());
            }
            _ => {}
        }
    }
    Ok(lookup)
}

pub(super) fn join_numbers(values: HashSet<u32>) -> String {
    let mut values: Vec<u32> = values.into_iter().collect();
    values.sort_unstable();
    values
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn remote_entry(
    parent: &str,
    name: String,
    metadata: FileAttributes,
    owner_lookup: &OwnerLookup,
) -> RemoteFileEntry {
    let file_type = sftp_file_type(metadata.file_type());
    let permissions = format!(
        "{}{}",
        match file_type {
            RemoteFileType::Directory => "d",
            RemoteFileType::Symlink => "l",
            _ => "-",
        },
        metadata.permissions()
    );
    let user = metadata
        .user
        .clone()
        .or_else(|| {
            metadata
                .uid
                .and_then(|uid| owner_lookup.users.get(&uid).cloned())
        })
        .unwrap_or_else(|| metadata.uid.map_or("-".to_string(), |uid| uid.to_string()));
    let group = metadata
        .group
        .clone()
        .or_else(|| {
            metadata
                .gid
                .and_then(|gid| owner_lookup.groups.get(&gid).cloned())
        })
        .unwrap_or_else(|| metadata.gid.map_or("-".to_string(), |gid| gid.to_string()));
    let owner = format!("{user}/{group}");
    RemoteFileEntry {
        key: join_remote_path(parent, &name),
        path: join_remote_path(parent, &name),
        name,
        file_type,
        size: metadata.len(),
        modified_at: metadata
            .modified()
            .ok()
            .map(system_time_rfc3339)
            .unwrap_or_default(),
        permissions,
        owner,
    }
}

pub(super) struct SearchEntry {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) is_directory: bool,
}

pub(super) fn search_entry(parent: &str, name: String, metadata: FileAttributes) -> SearchEntry {
    let path = join_remote_path(parent, &name);
    let is_directory = matches!(
        sftp_file_type(metadata.file_type()),
        RemoteFileType::Directory
    );
    SearchEntry {
        name,
        path,
        is_directory,
    }
}

pub(super) fn sftp_file_type(kind: SftpFileType) -> RemoteFileType {
    match kind {
        SftpFileType::Dir => RemoteFileType::Directory,
        SftpFileType::File => RemoteFileType::File,
        SftpFileType::Symlink => RemoteFileType::Symlink,
        SftpFileType::Other => RemoteFileType::Other,
    }
}

pub(super) fn system_time_rfc3339(time: SystemTime) -> String {
    let datetime: DateTime<Utc> = time.into();
    datetime.to_rfc3339()
}

pub(super) fn normalize_remote_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub(super) fn ensure_not_root_path(path: &str, message: &str) -> AppResult<()> {
    if normalize_remote_path(path) == "/" {
        Err(AppError::InvalidInput(message.to_string()))
    } else {
        Ok(())
    }
}

pub(super) fn is_same_or_child_remote_path(parent: &str, candidate: &str) -> bool {
    let parent = normalize_remote_path(parent);
    let candidate = normalize_remote_path(candidate);
    parent == candidate || (parent != "/" && candidate.starts_with(&format!("{parent}/")))
}

pub(super) fn ensure_not_same_or_child_path(
    source: &str,
    target: &str,
    message: &str,
) -> AppResult<()> {
    if is_same_or_child_remote_path(source, target) {
        Err(AppError::InvalidInput(message.to_string()))
    } else {
        Ok(())
    }
}

pub(super) fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}
