let documentPermissions = null;

function validatedDocumentPermissions(value) {
  if (!value || !["writable", "collaborative", "owner"].every((key) => typeof value[key] === "boolean")
      || value.collaborative && !value.writable) {
    throw new ApiError("The service returned incomplete document permissions.");
  }
  return value;
}

function acceptDocumentPermissions(value) {
  const next = validatedDocumentPermissions(value);
  const changed = !documentPermissions || ["writable", "collaborative", "owner"].some((key) => documentPermissions[key] !== next[key]);
  documentPermissions = next;
  if (publicView) publicWritable = value.writable;
  return changed;
}
