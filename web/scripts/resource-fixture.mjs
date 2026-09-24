export async function fixtureResourceId(launchUrl, path, kind = "document") {
  const launch = new URL(launchUrl);
  const token = launch.hash.match(/(?:^#|&)token=([a-f0-9]+)/i)?.[1];
  if (!token) throw new Error("The isolated service did not provide a launch token.");
  const response = await fetch(new URL("/api/resources/resolve", launch), {
    method: "POST",
    headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
    body: JSON.stringify({ path, kind }),
  });
  if (!response.ok) throw new Error(`Resource resolution failed (${response.status}): ${await response.text()}`);
  const { id } = await response.json();
  if (typeof id !== "string") throw new Error("The fixture resource has no ID.");
  return id;
}
