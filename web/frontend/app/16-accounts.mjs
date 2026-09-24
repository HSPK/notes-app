let accountBusy = false;
let passwordTarget = null;
const accountsUi = {
  list: element("accounts-list"), invitations: element("invitations-list"),
  error: element("accounts-error"), create: element("invite-create"),
  lifetime: element("invite-lifetime"), created: element("invite-created"), code: element("invite-code"),
  copy: element("invite-copy"), dialog: element("account-password-dialog"),
  password: element("account-password"), passwordError: element("account-password-error"),
};

function accountButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = accountBusy;
  button.addEventListener("click", action);
  return button;
}

function renderAccounts(value) {
  if (!Array.isArray(value?.users) || !Array.isArray(value?.invitations)) throw new ApiError("Incomplete account data.");
  const users = document.createDocumentFragment();
  for (const user of value.users) {
    const row = document.createElement("div");
    row.className = "account-row";
    const name = document.createElement("strong");
    name.textContent = user.username;
    const role = document.createElement("select");
    role.setAttribute("aria-label", `Role for ${user.username}`);
    for (const value of ["user", "admin"]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = value === "admin" ? "Administrator" : "User";
      role.append(option);
    }
    role.value = user.role;
    role.addEventListener("change", () => {
      if (!confirm(`Change ${user.username} to ${role.value}? Existing sessions for this account will end.`)) {
        role.value = user.role; return;
      }
      void accountAction({ action: "role", username: user.username, role: role.value });
    });
    row.append(name, role,
      accountButton("Reset password", () => {
        passwordTarget = user.username;
        accountsUi.password.value = "";
        setText(element("account-password-title"), `Reset password: ${user.username}`);
        notice(accountsUi.passwordError, "");
        accountsUi.dialog.showModal();
        accountsUi.password.focus();
      }),
      accountButton("Delete", () => {
        if (confirm(`Delete account ${user.username}? Their sessions will end; note files will not be deleted.`)) {
          void accountAction({ action: "delete", username: user.username });
        }
      }));
    users.append(row);
  }
  accountsUi.list.replaceChildren(users);
  const invitations = document.createDocumentFragment();
  for (const invite of value.invitations) {
    const row = document.createElement("div");
    row.className = "account-row invitation-row";
    const details = document.createElement("span");
    details.textContent = `${invite.id.slice(0, 8)} · ${invite.usedBy ? `Used by ${invite.usedBy}` : invite.expired
      ? "Expired" : `Expires ${new Date(invite.expiresAt * 1000).toLocaleString()}`}`;
    row.append(details, accountButton("Revoke", () => void accountAction({ action: "revokeInvite", id: invite.id })));
    invitations.append(row);
  }
  accountsUi.invitations.replaceChildren(invitations);
  if (!value.invitations.length) accountsUi.invitations.textContent = "No invitations.";
}

function accountControls() {
  accountsUi.create.disabled = accountBusy;
  for (const control of document.querySelectorAll("#accounts-list button, #accounts-list select, #invitations-list button, #account-password-form button")) {
    control.disabled = accountBusy;
  }
}

async function loadAccounts() {
  if (authUser?.role !== "admin" || accountBusy) return;
  accountBusy = true;
  accountControls();
  notice(accountsUi.error, "");
  try { renderAccounts(await api("/api/admin/accounts")); }
  catch (error) { notice(accountsUi.error, error.message, "error"); }
  finally { accountBusy = false; accountControls(); }
}

async function accountAction(body) {
  if (authUser?.role !== "admin" || accountBusy) return false;
  const self = body.username === authUser.username;
  if (self && !confirmDiscard("update your account and log in again")) return false;
  accountBusy = true;
  accountControls();
  notice(accountsUi.error, "");
  try {
    const response = await api("/api/admin/accounts", { method: "POST", body });
    if (self) { window.location.reload(); return true; }
    renderAccounts(response.accounts);
    if (response.code) {
      accountsUi.code.value = response.code;
      accountsUi.created.hidden = false;
      setText(accountsUi.copy, "Copy invitation");
    }
    return true;
  } catch (error) {
    notice(accountsUi.error, error.message, "error");
    if (accountsUi.dialog.open) notice(accountsUi.passwordError, error.message, "error");
    return false;
  } finally {
    if (body.password) body.password = "";
    accountBusy = false;
    accountControls();
  }
}

accountsUi.create.addEventListener("click", () =>
  void accountAction({ action: "invite", hours: Number(accountsUi.lifetime.value) }));
accountsUi.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(accountsUi.code.value);
    setText(accountsUi.copy, "Copied");
  } catch {
    accountsUi.code.focus(); accountsUi.code.select();
    notice(accountsUi.error, "Clipboard access is unavailable. Copy the selected invitation key manually.", "warning");
  }
});
ui.settingsDialog.addEventListener("close", () => {
  accountsUi.code.value = "";
  accountsUi.created.hidden = true;
});
element("account-password-cancel").addEventListener("click", () => accountsUi.dialog.close());
accountsUi.dialog.addEventListener("close", () => { accountsUi.password.value = ""; passwordTarget = null; });
element("account-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!passwordTarget) return;
  const saved = await accountAction({ action: "password", username: passwordTarget, password: accountsUi.password.value });
  accountsUi.password.value = "";
  if (saved) accountsUi.dialog.close();
});
element("auth-use-invitation").addEventListener("click", () => showAuthentication(false, "", true));
element("auth-back-login").addEventListener("click", () => {
  element("auth-invitation").value = "";
  ui.authPassword.value = ""; ui.authConfirm.value = "";
  showAuthentication(false);
});
