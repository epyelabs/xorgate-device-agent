#!/usr/bin/env node
// Test helper: create + provision a fresh device on the seeded XG-RPI-REF-1
// model, then write the one-shot cert bundle into ./creds so the simulator can
// run. Re-runnable (each run makes a NEW device → a fresh cert).
//
// Usage:
//   ID_TOKEN="<cognito idToken>" node scripts/provision-test-device.mjs
//
// Optional env: API_BASE_URL, ORG_ID, PROJECT_ID, MODEL_SKU, SERIAL.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const API_BASE_URL =
  process.env.API_BASE_URL ??
  "https://h357muxy3k.execute-api.us-east-1.amazonaws.com"
const ID_TOKEN = process.env.ID_TOKEN
const MODEL_SKU = process.env.MODEL_SKU ?? "XG-RPI-REF-1"
const SERIAL = process.env.SERIAL ?? `sim-${Date.now()}`
const CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem"

if (!ID_TOKEN) {
  console.error("ID_TOKEN env var is required (a Cognito idToken; see README).")
  process.exit(1)
}

async function api(path, init = {}, orgId) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ID_TOKEN}`,
    ...(orgId ? { "X-Organization-Id": orgId } : {}),
    ...(init.headers ?? {}),
  }
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text}`)
  }
  return text ? JSON.parse(text) : {}
}

// 1. Resolve an org where the user is owner/admin (provisioning needs that role).
const me = await api("/me")
let orgId = process.env.ORG_ID
if (!orgId) {
  const m = (me.memberships ?? []).find(
    (x) => x.role === "owner" || x.role === "admin",
  )
  if (!m) throw new Error("No owner/admin org membership found for this user.")
  orgId = m.organizationId
}
console.log(`org:     ${orgId}`)

// 2. Find the device model by SKU.
const models = await api("/device-models", {}, orgId)
const model = (models.device_models ?? []).find((dm) => dm.sku === MODEL_SKU)
if (!model) throw new Error(`Device model with sku "${MODEL_SKU}" not found.`)
console.log(`model:   ${model.id} (${MODEL_SKU})`)

// 3. Pick a project in that org.
let projectId = process.env.PROJECT_ID
if (!projectId) {
  const projects = await api("/projects", {}, orgId)
  const first = (projects.projects ?? [])[0]
  if (!first) throw new Error("No project found in this org; set PROJECT_ID.")
  projectId = first.id
}
console.log(`project: ${projectId}`)

// 4. Create a fresh device.
const createBody = {
  projectId,
  deviceModelId: model.id,
  serial: SERIAL,
  name: `Simulator ${SERIAL}`,
}
const { device } = await api(
  "/devices",
  { method: "POST", body: JSON.stringify(createBody) },
  orgId,
)
console.log(`device:  ${device.id} (serial ${SERIAL})`)

// 5. Provision it (mints cert + KVS channels; returns the bundle ONCE).
const prov = await api(
  `/devices/${device.id}/provision`,
  { method: "POST", body: "{}" },
  orgId,
)

// 6. Write the cert bundle into ./creds and fetch the Amazon Root CA.
const credsDir = resolve("./creds")
mkdirSync(credsDir, { recursive: true })
writeFileSync(resolve(credsDir, "cert.crt"), prov.iot.certificatePem)
writeFileSync(resolve(credsDir, "private.key"), prov.iot.privateKey)
const ca = await fetch(CA_URL).then((r) => r.text())
writeFileSync(resolve(credsDir, "ca.pem"), ca)

// 7. Write a KVS manifest the synthetic-video master needs (the cert bundle alone
//    is missing the credential endpoint, role alias, region, and channel names —
//    all of which the provision response returns but we'd otherwise drop).
const kvsManifest = {
  deviceId: device.id,
  region: prov.kvs?.region,
  credentialEndpoint: prov.iot.credentialEndpoint,
  roleAlias: prov.iot.roleAlias,
  channels: (prov.kvs?.channels ?? []).map((c) => ({
    streamKey: c.streamKey,
    channelName: c.channelName,
    channelArn: c.channelArn,
  })),
}
writeFileSync(
  resolve(credsDir, "kvs.json"),
  JSON.stringify(kvsManifest, null, 2),
)

console.log(
  "\n✅ wrote creds/cert.crt, creds/private.key, creds/ca.pem, creds/kvs.json",
)
console.log("\nRun the telemetry simulator with:\n")
console.log(
  `  DEVICE_ID=${device.id} IOT_DATA_ENDPOINT=${prov.iot.dataEndpoint} npm start\n`,
)
console.log("Run the synthetic-video master (feeds the live VIEWER) with:\n")
console.log(
  `  docker run --rm -v "${credsDir}:/creds:ro" xorgate-synthetic-master\n`,
)
console.log(`Live screen: /devices/${device.id}/live`)
