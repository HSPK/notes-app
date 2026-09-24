use std::{ffi::OsString, io::Read, path::PathBuf};

use notes_core::auth::{Role, UserStore, validate_password};
use zeroize::Zeroizing;

#[derive(Debug, Eq, PartialEq)]
enum UserCommand {
    List {
        auth_file: Option<PathBuf>,
    },
    Add {
        username: String,
        role: Role,
        auth_file: Option<PathBuf>,
        password_stdin: bool,
    },
    Password {
        username: String,
        auth_file: Option<PathBuf>,
        password_stdin: bool,
    },
    Remove {
        username: String,
        auth_file: Option<PathBuf>,
    },
}

pub(crate) fn run(args: &[OsString]) -> Result<(), String> {
    let command = parse(args)?;
    let store = store(command_auth_file(&command))?;
    match command {
        UserCommand::List { .. } => {
            for user in store.list()? {
                println!("{}\t{}", user.username, role_name(user.role));
            }
        }
        UserCommand::Add {
            username,
            role,
            password_stdin,
            ..
        } => {
            let password = read_password(password_stdin, true)?;
            let user = store.add(&username, &password, role)?;
            println!("Added {} ({})", user.username, role_name(user.role));
        }
        UserCommand::Password {
            username,
            password_stdin,
            ..
        } => {
            let password = read_password(password_stdin, true)?;
            store.set_password(&username, &password)?;
            println!(
                "Updated the password for {username}. Restart running Notes services to revoke existing sessions."
            );
        }
        UserCommand::Remove { username, .. } => {
            store.remove(&username)?;
            println!(
                "Removed {username}. Restart running Notes services to revoke existing sessions."
            );
        }
    }
    Ok(())
}

fn parse(args: &[OsString]) -> Result<UserCommand, String> {
    let operation = args
        .first()
        .and_then(|value| value.to_str())
        .ok_or("Expected user list, add, password or remove. Use --help.")?;
    let needs_username = matches!(operation, "add" | "password" | "remove");
    let mut index = 1;
    let username = if needs_username {
        let value = args
            .get(index)
            .and_then(|value| value.to_str())
            .ok_or("This user operation requires a UTF-8 username.")?;
        index += 1;
        Some(value.to_owned())
    } else {
        None
    };
    let mut auth_file = None;
    let mut password_stdin = false;
    let mut role = Role::User;
    while index < args.len() {
        let option = args[index]
            .to_str()
            .ok_or("Invalid user option encoding.")?;
        match option {
            "--auth-file" => {
                if auth_file.is_some() {
                    return Err("Option specified more than once: --auth-file".into());
                }
                auth_file = Some(PathBuf::from(
                    args.get(index + 1).ok_or("--auth-file requires a path.")?,
                ));
                index += 2;
            }
            "--password-stdin" if matches!(operation, "add" | "password") => {
                if password_stdin {
                    return Err("Option specified more than once: --password-stdin".into());
                }
                password_stdin = true;
                index += 1;
            }
            "--role" if operation == "add" => {
                let value = args
                    .get(index + 1)
                    .and_then(|value| value.to_str())
                    .ok_or("--role requires admin or user.")?;
                role = match value {
                    "admin" => Role::Admin,
                    "user" => Role::User,
                    _ => return Err("--role requires admin or user.".into()),
                };
                index += 2;
            }
            _ => return Err(format!("Unknown option for user {operation}: {option}")),
        }
    }
    match operation {
        "list" if username.is_none() => Ok(UserCommand::List { auth_file }),
        "add" => Ok(UserCommand::Add {
            username: username.unwrap(),
            role,
            auth_file,
            password_stdin,
        }),
        "password" => Ok(UserCommand::Password {
            username: username.unwrap(),
            auth_file,
            password_stdin,
        }),
        "remove" => Ok(UserCommand::Remove {
            username: username.unwrap(),
            auth_file,
        }),
        _ => Err("Expected user list, add, password or remove. Use --help.".into()),
    }
}

fn command_auth_file(command: &UserCommand) -> Option<&PathBuf> {
    match command {
        UserCommand::List { auth_file }
        | UserCommand::Add { auth_file, .. }
        | UserCommand::Password { auth_file, .. }
        | UserCommand::Remove { auth_file, .. } => auth_file.as_ref(),
    }
}

fn store(path: Option<&PathBuf>) -> Result<UserStore, String> {
    path.map(|path| Ok(UserStore::new(path)))
        .unwrap_or_else(UserStore::platform_default)
}

fn read_password(from_stdin: bool, confirm: bool) -> Result<Zeroizing<String>, String> {
    let password = if from_stdin {
        let mut input = String::new();
        std::io::stdin()
            .take(2048)
            .read_to_string(&mut input)
            .map_err(|error| format!("Could not read the password from stdin: {error}"))?;
        if input.ends_with('\n') {
            input.pop();
            if input.ends_with('\r') {
                input.pop();
            }
        }
        if input.contains(['\r', '\n']) {
            return Err("Password stdin must contain exactly one line.".into());
        }
        Zeroizing::new(input)
    } else {
        Zeroizing::new(
            rpassword::prompt_password("Password: ")
                .map_err(|error| format!("Could not read the password: {error}"))?,
        )
    };
    validate_password(&password)?;
    if confirm && !from_stdin {
        let confirmation = Zeroizing::new(
            rpassword::prompt_password("Confirm password: ")
                .map_err(|error| format!("Could not read the password confirmation: {error}"))?,
        );
        if password.as_str() != confirmation.as_str() {
            return Err("The password confirmation does not match.".into());
        }
    }
    Ok(password)
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Admin => "admin",
        Role::User => "user",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_account_management_without_password_arguments() {
        assert_eq!(
            parse(&args(&[
                "add",
                "writer",
                "--role",
                "admin",
                "--auth-file",
                "users.json",
                "--password-stdin",
            ]))
            .unwrap(),
            UserCommand::Add {
                username: "writer".into(),
                role: Role::Admin,
                auth_file: Some(PathBuf::from("users.json")),
                password_stdin: true,
            }
        );
        assert!(parse(&args(&["add", "writer", "--password", "secret"])).is_err());
        assert!(parse(&args(&["remove"])).is_err());
    }
}
