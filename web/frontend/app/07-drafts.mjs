const draftEncoder = new TextEncoder();
const draftDecoder = new TextDecoder();
let draftDatabase = null;
let draftKeys = null;
let draftKeySignature = null;
let draftTimer = null;
let draftQueue = Promise.resolve();
let draftTouched = -1;
let draftRecovery = null;
function draftNonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
let draftTab = draftNonce();
try {
  draftTab = sessionStorage.getItem("notes.draft.tab") ?? draftTab;
  sessionStorage.setItem("notes.draft.tab", draftTab);
} catch (error) { console.warn("Draft tab identity cannot be retained.", error); }

function localRecoveryAvailable() {
  return Boolean(crypto.subtle);
}

function openDraftDatabase() {
  draftDatabase ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("notes-private-drafts", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("drafts", { keyPath: "key" });
      store.createIndex("document", "document");
      store.createIndex("owner", "owner");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { draftDatabase = null; reject(request.error); };
    request.onblocked = () => documentNotice("Local recovery storage is blocked by another tab. Close old Notes tabs to finish upgrading.", "warning");
  });
  return draftDatabase;
}

async function draftIdentity() {
  if (!crypto.subtle) throw new Error("Encrypted local recovery requires HTTPS or localhost.");
  const secret = authMode === "users" ? authUser?.draftKey : publicView ? publicToken : token;
  const scope = authMode === "users" ? `${authUser?.scope}:${authUser?.id}` : publicView ? "public-link" : currentRoot;
  if (!/^[a-f0-9]{64}$/i.test(secret ?? "") || !scope) throw new Error("The private recovery key is unavailable. Reconnect before closing unsaved work.");
  const signature = `${scope}:${secret}`;
  if (draftKeySignature === signature) return draftKeys;
  draftKeySignature = signature;
  draftKeys = (async () => {
    const raw = Uint8Array.from(secret.match(/../g), (byte) => parseInt(byte, 16));
    const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    const derive = (purpose, algorithm, usages) => crypto.subtle.deriveKey({
      name: "HKDF", hash: "SHA-256", salt: draftEncoder.encode(scope), info: draftEncoder.encode(purpose),
    }, master, algorithm, false, usages);
    const encryption = await derive("notes-draft-content", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
    const naming = await derive("notes-draft-identifiers", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
    const identify = async (text) => [...new Uint8Array(await crypto.subtle.sign("HMAC", naming, draftEncoder.encode(text)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { encryption, identify, owner: await identify("owner") };
  })();
  return draftKeys;
}

async function draftTransaction(mode, operation) {
  const database = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local recovery storage was interrupted."));
    operation(transaction.objectStore("drafts"), (value) => { result = value; });
  });
}

async function encryptDraft(keys, value, associated) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = draftEncoder.encode(JSON.stringify(value));
  const compressed = typeof CompressionStream !== "undefined";
  const input = compressed ? await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer() : bytes;
  const payload = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: draftEncoder.encode(associated) }, keys.encryption, input);
  return { iv, compressed, payload: new Blob([payload]) };
}

async function decryptDraft(keys, record) {
  const plain = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: record.iv, additionalData: draftEncoder.encode(record.key),
  }, keys.encryption, await record.payload.arrayBuffer());
  const bytes = record.compressed
    ? await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer() : plain;
  const value = JSON.parse(draftDecoder.decode(bytes));
  if (typeof value.path !== "string" || typeof value.source !== "string" || typeof value.project !== "string") {
    throw new Error("This local recovery record is invalid.");
  }
  return { ...value, key: record.key, generation: record.generation, updated: record.updated };
}

function encodeDraftUpdates(updates) {
  if (!updates.length) return "";
  const bytes = mergeSharedUpdates(updates);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(""));
}
function decodeDraftUpdates(value) { return value ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) : null; }
function draftProject() { return activeProject?.id ?? (publicView ? "public" : currentRoot); }

function captureDraft() {
  if (!activeDocument) return null;
  const shared = collaboration?.id === documentId ? collaboration : null;
  if (draftTouched !== documentId && !shared?.localModified && !shared?.recoveryRecord) return null;
  return {
    keep: dirty() || Boolean(shared?.localUpdates.size || shared?.pending.size || shared?.unmerged),
    project: draftProject(), document: activeDocument.id, path: activeDocument.path, source: ui.editor.value, version: activeDocument.version,
    room: shared?.room ?? null, updates: encodeDraftUpdates(shared ? [...shared.localUpdates.values()] : []),
    unmerged: Boolean(shared?.unmerged), selection: collaborativeSelection(), tab: draftTab,
  };
}

async function removeDraftRecord(key, generation = null) {
  await draftTransaction("readwrite", (store) => {
    const found = store.get(key);
    found.onsuccess = () => {
      if (found.result && (!generation || found.result.generation === generation)) store.delete(key);
    };
  });
}

function persistCurrentDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  let snapshot;
  try { snapshot = captureDraft(); }
  catch (error) { documentNotice(`Local recovery failed: ${error.message}`, "warning"); return Promise.resolve(); }
  if (!snapshot) return Promise.resolve();
  if (!localRecoveryAvailable()) {
    return snapshot.keep
      ? Promise.reject(new Error("Encrypted local recovery requires HTTPS or localhost. Save or copy unsaved text before leaving this document."))
      : Promise.resolve();
  }
  const identity = draftIdentity().then((keys) => ({ keys }), (error) => ({ error }));
  draftQueue = draftQueue.catch((error) => console.error("An earlier local draft write failed.", error)).then(async () => {
    const result = await identity;
    if (result.error) throw result.error;
    const keys = result.keys;
    const document = await keys.identify(`${snapshot.project}\0${snapshot.document}`);
    const key = await keys.identify(`${snapshot.project}\0${snapshot.document}\0${snapshot.tab}`);
    if (!snapshot.keep) { await removeDraftRecord(key); return; }
    const encrypted = await encryptDraft(keys, snapshot, key);
    await draftTransaction("readwrite", (store) => {
      store.put({ ...encrypted, key, document, owner: keys.owner, updated: Date.now(), generation: draftNonce() });
    });
  });
  return draftQueue.catch((error) => {
    documentNotice(`Local recovery could not be saved: ${error.message} Keep this tab open or copy your text.`, "warning");
    throw error;
  });
}

function queueDraftPersistence(local = false) {
  if (local) draftTouched = documentId;
  if (!localRecoveryAvailable()) return;
  if (draftTimer === null) draftTimer = setTimeout(() => { void persistCurrentDraft().catch(console.error); }, 250);
}

function finishLocalDraft() {
  if (!activeDocument || dirty() || collaboration?.localUpdates.size || collaboration?.pending.size || collaboration?.unmerged) return;
  if (collaboration && !collaboration.initialized) return;
  const record = collaboration?.recoveryRecord;
  const pending = persistCurrentDraft();
  draftTouched = -1;
  if (collaboration) { collaboration.localModified = false; collaboration.recoveryRecord = null; }
  void pending.then(async () => { if (record) await removeDraftRecord(record.key, record.generation); })
    .catch((error) => documentNotice(`Could not clear local recovery: ${error.message}`, "warning"));
}

async function loadDraftForDocument(project, id) {
  await draftQueue.catch((error) => console.error("Local draft storage is unavailable.", error));
  const keys = await draftIdentity();
  const document = await keys.identify(`${project}\0${id}`);
  const records = await draftTransaction("readonly", (store, result) => {
    const request = store.index("document").getAll(document);
    request.onsuccess = () => result(request.result);
  });
  records.sort((left, right) => right.updated - left.updated);
  for (const record of records) {
    if (record.owner !== keys.owner) continue;
    const draft = await decryptDraft(keys, record);
    if (draft.project === project && draft.document === id) return draft;
  }
  return null;
}

async function recoverDocumentDraft() {
  if (!activeDocument) return;
  if (!localRecoveryAvailable()) return;
  const id = documentId;
  try {
    const record = await loadDraftForDocument(draftProject(), activeDocument.id);
    if (!record || id !== documentId) return;
    if (record.source === ui.editor.value && !record.updates) {
      await removeDraftRecord(record.key, record.generation);
      return;
    }
    if (!collaboration && documentParticipation && documentPermissions?.collaborative
        && record.room && !record.unmerged) {
      documentParticipation.recoveryRecord = record;
      collaborationNotice("A local collaborative draft is kept. It will merge when shared editing resumes.");
      return;
    }
    if (collaboration) {
      const current = collaboration;
      if (!current.initialized && record.room && !record.unmerged) {
        const update = decodeDraftUpdates(record.updates);
        if (update) {
          current.shared.apply(update);
          current.localUpdates.set(++current.localSequence, update);
          current.localModified = true;
        }
        current.room = record.room;
        current.recoveryRecord = record;
        return;
      }
    }
    showDraftRecovery(record);
  } catch (error) { documentNotice(`Could not read local recovery: ${error.message}`, "warning"); }
}

function showDraftRecovery(record) {
  draftRecovery = record;
  element("draft-recovery-info").textContent = `${record.path} · ${new Date(record.updated).toLocaleString()}`;
  element("draft-recovery-source").value = record.source.slice(0, 200_000);
  element("draft-recovery-apply").disabled = !activeDocument || activeDocument.id !== record.document || draftProject() !== record.project
    || !(activeProject?.owned || projectWritable());
  notice(element("draft-recovery-error"), record.source.length > 200_000 ? "Preview truncated. Copy draft preserves the complete text." : "");
  if (!element("draft-recovery-dialog").open) element("draft-recovery-dialog").showModal();
}

element("draft-recovery-close").addEventListener("click", () => element("draft-recovery-dialog").close());
element("draft-recovery-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(draftRecovery.source); documentNotice("Recovered draft copied.", "success"); }
  catch (error) { notice(element("draft-recovery-error"), error.message, "error"); }
});
element("draft-recovery-discard").addEventListener("click", async () => {
  if (!window.confirm("Permanently discard this local recovery copy?")) return;
  try { await removeDraftRecord(draftRecovery.key, draftRecovery.generation); element("draft-recovery-dialog").close(); }
  catch (error) { notice(element("draft-recovery-error"), error.message, "error"); }
});
element("draft-recovery-apply").addEventListener("click", async () => {
  const record = draftRecovery;
  if (!activeDocument || record.document !== activeDocument.id || record.project !== draftProject()) return;
  if (!window.confirm("Apply this draft as a new edit? Review it first: it may replace newer text.")) return;
  try {
    if (collaboration?.initialized && !collaboration.closed && projectWritable()) {
      ui.editor.value = record.source;
      ui.editor.dispatchEvent(new Event("input"));
      loadInlineEditor();
      await persistCurrentDraft();
    } else {
      const current = expectDocument(await api(`/api/document?id=${encodeURIComponent(record.document)}`));
      const model = createDocumentModel(current);
      const saved = await api("/api/document", { method: "PUT", body: {
        id: record.document, version: current.version, content: serializeEditorText(model, record.source),
      } });
      useDocument(saved, currentRoot, new URL(committedUrl), "replace", "Recovered the local draft.");
    }
    await removeDraftRecord(record.key, record.generation);
    element("draft-recovery-dialog").close();
  } catch (error) { notice(element("draft-recovery-error"), error.message, "error"); }
});

element("drafts-open").addEventListener("click", async () => {
  closeMenus();
  try {
    const keys = await draftIdentity();
    const records = await draftTransaction("readonly", (store, result) => {
      const request = store.index("owner").getAll(keys.owner);
      request.onsuccess = () => result(request.result);
    });
    records.sort((a, b) => b.updated - a.updated);
    const list = element("drafts-list");
    list.replaceChildren();
    for (const record of records) {
      const draft = await decryptDraft(keys, record);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${draft.path} · ${new Date(draft.updated).toLocaleString()}`;
      button.addEventListener("click", () => { element("drafts-dialog").close(); showDraftRecovery(draft); });
      list.append(button);
    }
    notice(element("drafts-message"), records.length ? "" : "No unsaved local drafts.");
    element("drafts-dialog").showModal();
  } catch (error) { documentNotice(`Local recovery is unavailable: ${error.message}`, "error"); }
});
element("drafts-close").addEventListener("click", () => element("drafts-dialog").close());
window.addEventListener("pagehide", () => { void persistCurrentDraft().catch(console.error); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void persistCurrentDraft().catch(console.error); });
