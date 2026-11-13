// Generated from the PC import parsers; update with node tools/sync-desktop-import.mjs.
// src/main/services/rdo-import.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/shared/connection-identity.ts
function parseConnectionAddress(address, fallbackPort) {
  let host = address.trim();
  let port = fallbackPort;
  if (!host) throw new Error("\u8BF7\u586B\u5199\u4E3B\u673A\u5730\u5740");
  if (/[\s/\\@?#]/.test(host)) throw new Error("\u4E3B\u673A\u5730\u5740\u53EA\u9700\u586B\u5199 IP \u6216\u57DF\u540D\uFF0C\u53EF\u9644\u5E26\u7AEF\u53E3\uFF1B\u4E0D\u8981\u5305\u542B\u534F\u8BAE\u3001\u8DEF\u5F84\u6216\u8D26\u53F7");
  let explicitPort;
  if (host.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(.*))?$/.exec(host);
    if (!match || !match[1].includes(":")) throw new Error("IPv6 \u5730\u5740\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u5E26\u7AEF\u53E3\u65F6\u8BF7\u586B\u5199 [\u5730\u5740]:\u7AEF\u53E3");
    host = match[1];
    explicitPort = match[2];
  } else if (host.indexOf(":") === host.lastIndexOf(":") && host.includes(":")) {
    const separator = host.indexOf(":");
    explicitPort = host.slice(separator + 1);
    host = host.slice(0, separator);
  }
  if (!host || /[\[\]]/.test(host)) throw new Error("\u4E3B\u673A\u5730\u5740\u683C\u5F0F\u4E0D\u6B63\u786E");
  if (host.includes(":")) {
    const [ip, zone, ...rest] = host.split("%");
    try {
      if (rest.length || zone !== void 0 && !/^[\w.-]+$/.test(zone)) throw new Error();
      new URL(`http://[${ip}]/`);
    } catch {
      throw new Error("IPv6 \u5730\u5740\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u5E26\u7AEF\u53E3\u65F6\u8BF7\u586B\u5199 [\u5730\u5740]:\u7AEF\u53E3");
    }
  }
  if (explicitPort !== void 0) {
    if (!/^\d+$/.test(explicitPort)) throw new Error("\u5730\u5740\u4E2D\u7684\u7AEF\u53E3\u5FC5\u987B\u4E3A 1\u201365535 \u4E4B\u95F4\u7684\u6574\u6570");
    port = Number(explicitPort);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("\u7AEF\u53E3\u5FC5\u987B\u4E3A 1\u201365535 \u4E4B\u95F4\u7684\u6574\u6570");
  return { host, port };
}
function connectionKey(connection) {
  let endpoint = { host: connection.host, port: connection.port };
  try {
    endpoint = parseConnectionAddress(connection.host, connection.port);
  } catch {
  }
  let host = endpoint.host.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(":")) {
    try {
      host = new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, "");
    } catch {
    }
  }
  return `${connection.kind}|${host}|${endpoint.port}`;
}

// src/main/services/xt-import.ts
import { randomUUID } from "node:crypto";
function parseXTerminalRecords({ sshRecords, rdpRecords, identities, groups }, existing = []) {
  const groupName = buildGroupNamer(groups);
  const existingKeys = new Set(existing.map(connectionKey));
  const credentials = /* @__PURE__ */ new Map();
  const candidates = [];
  let missingCredentials = 0;
  for (const kind of ["ssh", "rdp"]) {
    for (const record of kind === "ssh" ? sshRecords : rdpRecords) {
      const identity = record.authType === "identity" ? identities.find((item) => item._id === record.identityId) : void 0;
      const source = record.authType === "identity" ? identity : record;
      const usable = !!source && source.isReady === true && !source.errors?.length;
      const auth = kind === "rdp" && !record.errors?.length ? record.authDecrypted : void 0;
      const passwordInfo = typeof source?.password === "object" ? source.password : void 0;
      const keyInfo = typeof source?.privateKey === "object" ? source.privateKey : void 0;
      const isKey = source?.authType === "privateKey" || /PRIVATE.?KEY/i.test(source?.type ?? "");
      const rawHost = kind === "rdp" ? auth?.address : record.host;
      const inferred = !rawHost ? extractHostFromTitle(record.title ?? "") : null;
      const host = String(rawHost || inferred || "").trim();
      const portInTitle = !rawHost ? /:(\d{1,5})(?:\s|$)/.exec(record.title ?? "")?.[1] : void 0;
      const port = Number(kind === "rdp" ? auth?.port ?? portInTitle : record.port) || (kind === "rdp" ? 3389 : 22);
      const username = String(auth?.username ?? ((usable ? passwordInfo?.username || keyInfo?.username : void 0) || record.username || "")).trim();
      const tempId = randomUUID();
      let credential;
      if (kind === "rdp" && typeof auth?.password === "string" && auth.password) credential = { secret: auth.password };
      else if (kind === "ssh" && usable) {
        const secret = isKey ? keyInfo?.privateKey ?? source.privateKey : passwordInfo?.password ?? source.password;
        if (typeof secret === "string" && secret) credential = { secret, passphrase: isKey ? keyInfo?.passphrase ?? source.passphrase : void 0 };
      }
      if (credential) credentials.set(tempId, credential);
      else missingCredentials++;
      const key2 = connectionKey({ kind, host, port });
      const duplicate = !!host && existingKeys.has(key2);
      if (host) existingKeys.add(key2);
      candidates.push({
        tempId,
        kind,
        name: String(record.title || host).trim(),
        host,
        port,
        username,
        domain: auth?.domain,
        authMethod: isKey ? "privateKey" : "password",
        credentialAvailable: !!credential,
        group: record.groupId ? groupName(record.groupId) : void 0,
        note: typeof record.note === "string" ? record.note : void 0,
        hostInferred: !!inferred,
        usernameMissing: !username,
        sourceTitle: record.title ?? "",
        duplicate
      });
    }
  }
  const warnings = [];
  if (missingCredentials) warnings.push(`${missingCredentials} \u6761\u8FDE\u63A5\u672A\u8BFB\u53D6\u5230\u5BC6\u7801\u6216\u79C1\u94A5\u3002\u8BF7\u5148\u5728 XTerminal \u89E3\u9501\u4ED3\u5E93\u5E76\u4FDD\u5B58\uFF0C\u518D\u91CD\u65B0\u626B\u63CF\uFF1B\u4ECD\u4E0D\u53EF\u8BFB\u7684\u9879\u53EF\u5148\u5BFC\u5165\u8FDE\u63A5\u4FE1\u606F\u3002`);
  if (candidates.some((item) => item.hostInferred)) warnings.push("\u6807\u9EC4\u5730\u5740\u7531\u540D\u79F0\u63A8\u65AD\uFF0C\u8BF7\u6838\u5BF9\u540E\u52FE\u9009\u3002");
  return {
    candidates,
    credentials,
    summary: {
      sshTotal: sshRecords.length,
      rdpTotal: rdpRecords.length,
      groups: groups.length,
      encryptedCredentials: missingCredentials,
      duplicates: candidates.filter((item) => item.duplicate).length
    },
    warnings
  };
}
function extractHostFromTitle(title) {
  const t = title.trim();
  if (!t) return null;
  const cleaned = t.replace(/^[\s[【(（]+|[\s\]】)）]+$/g, "");
  const ipv4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d{1,5}))?$/.exec(cleaned);
  if (ipv4) {
    const octets = ipv4[1].split(".").map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) return ipv4[1];
  }
  const hostname = /^([a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+)(?::(\d{1,5}))?$/.exec(cleaned);
  if (hostname) return hostname[1];
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(cleaned);
  if (embedded) {
    const octets = embedded[1].split(".").map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) return embedded[1];
  }
  return null;
}
function buildGroupNamer(groups) {
  const byId = /* @__PURE__ */ new Map();
  for (const g of groups) {
    if (g._id) byId.set(g._id, g);
  }
  const resolve = (id, depth = 0) => {
    if (depth > 8) return null;
    const g = byId.get(id);
    if (!g?.name) return null;
    if (!g.parentId) return g.name;
    const parent = resolve(g.parentId, depth + 1);
    return parent ? `${parent} / ${g.name}` : g.name;
  };
  return (id) => resolve(id) ?? void 0;
}
function candidateToConnection(c) {
  const now = Date.now();
  if (c.kind === "ssh") {
    const conn2 = {
      id: "",
      kind: "ssh",
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      authMethod: c.authMethod ?? "password",
      group: c.group,
      note: c.note,
      exposedToExternal: false,
      createdAt: now,
      updatedAt: now
    };
    return conn2;
  }
  const conn = {
    id: "",
    kind: "rdp",
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    domain: c.domain,
    group: c.group,
    note: c.note,
    exposedToExternal: false,
    options: {
      dynamicResolution: true,
      enableClipboard: true,
      ignoreCertificate: true,
      ...c.rdpOptions
    },
    createdAt: now,
    updatedAt: now
  };
  return conn;
}

// src/main/services/rdo-nrbf.ts
import { TextDecoder } from "node:util";
var MAX_ITEMS = 1e5;
var MAX_DEPTH = 64;
var END = Symbol("end");
var utf8 = new TextDecoder("utf-8", { fatal: true });
function decodeNrbf(bytes) {
  let offset = 0;
  let operations = 0;
  let allocated = 0;
  const objects = /* @__PURE__ */ new Map();
  const metadata = /* @__PURE__ */ new Map();
  const references = [];
  const fail = () => {
    throw new Error("RDO \u4E8C\u8FDB\u5236\u6570\u636E\u65E0\u6548\u3001\u5DF2\u635F\u574F\u6216\u5305\u542B\u6682\u4E0D\u652F\u6301\u7684\u7ED3\u6784");
  };
  const consume = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) return fail();
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const byte = () => consume(1)[0];
  const int = () => consume(4).readInt32LE();
  const count = (value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ITEMS || (allocated += value) > 5e5) return fail();
    return value;
  };
  const text = () => {
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const next = byte();
      if (shift === 28 && next > 7) return fail();
      length += (next & 127) * 2 ** shift;
      if (!(next & 128)) {
        if (length > 1024 * 1024) return fail();
        return utf8.decode(consume(length));
      }
    }
    return fail();
  };
  const store = (id, value) => {
    if (!id || objects.has(id) || objects.size >= MAX_ITEMS) return fail();
    objects.set(id, value);
    return value;
  };
  const primitive = (type) => {
    switch (type) {
      case 1: {
        const value = byte();
        if (value > 1) return fail();
        return !!value;
      }
      case 2:
        return byte();
      case 3: {
        const first = byte();
        const length = first < 128 ? 1 : first >= 194 && first < 224 ? 2 : first < 240 && first >= 224 ? 3 : 0;
        if (!length) return fail();
        return utf8.decode(Buffer.concat([Buffer.from([first]), consume(length - 1)]));
      }
      case 5:
        return text();
      case 6:
        return consume(8).readDoubleLE();
      case 7:
        return consume(2).readInt16LE();
      case 8:
        return int();
      case 9:
      case 12:
      case 13:
        return consume(8).readBigInt64LE();
      case 10:
        return consume(1).readInt8();
      case 11:
        return consume(4).readFloatLE();
      case 14:
        return consume(2).readUInt16LE();
      case 15:
        return consume(4).readUInt32LE();
      case 16:
        return consume(8).readBigUInt64LE();
      default:
        return fail();
    }
  };
  const memberType = (type) => {
    if (type < 0 || type > 7) return fail();
    if (type === 0 || type === 7) return { type, primitive: byte() };
    if (type === 3) text();
    if (type === 4) {
      text();
      int();
    }
    return { type };
  };
  const objectValue = (depth) => {
    const value = record(depth);
    if (value === END || value && typeof value === "object" && "nulls" in value) return fail();
    return value;
  };
  const classValues = (id, description, depth) => {
    const value = { type: description.type, members: /* @__PURE__ */ new Map() };
    store(id, value);
    description.names.forEach((name, index) => {
      const field = description.types[index];
      value.members.set(name, field.type === 0 ? primitive(field.primitive) : objectValue(depth + 1));
    });
    return value;
  };
  const arrayValues = (id, length, type, depth) => {
    if (type.type === 0 && type.primitive === 2) return store(id, Buffer.from(consume(length)));
    const values = [];
    store(id, values);
    while (values.length < length) {
      const value = type.type === 0 ? primitive(type.primitive) : record(depth + 1);
      if (value === END) return fail();
      if (value && typeof value === "object" && "nulls" in value) {
        if (value.nulls < 1 || value.nulls > length - values.length) return fail();
        for (let index = 0; index < value.nulls; index++) values.push(null);
      } else values.push(value);
    }
    return values;
  };
  const record = (depth) => {
    if (depth > MAX_DEPTH || ++operations > 5e5) return fail();
    let tag = byte();
    while (tag === 12) {
      int();
      text();
      if (++operations > 5e5) return fail();
      tag = byte();
    }
    switch (tag) {
      case 1: {
        const id = int();
        const description = metadata.get(int());
        if (!description) return fail();
        return classValues(id, description, depth);
      }
      case 2:
      case 3:
      case 4:
      case 5: {
        const id = int();
        const type = text();
        const length = count(int());
        const names = [];
        for (let index = 0; index < length; index++) names.push(text());
        if (new Set(names).size !== names.length) return fail();
        const typeCodes = [];
        for (let index = 0; index < length; index++) typeCodes.push(tag >= 4 ? byte() : 2);
        const types = typeCodes.map(memberType);
        if (tag === 3 || tag === 5) int();
        const description = { type, names, types };
        metadata.set(id, description);
        return classValues(id, description, depth);
      }
      case 6: {
        const id = int();
        return store(id, text());
      }
      case 7: {
        const id = int();
        const arrayType = byte();
        const rank = int();
        if (arrayType > 5 || rank < 1 || rank > 4) return fail();
        let length = 1;
        for (let dimension = 0; dimension < rank; dimension++) {
          const size = int();
          if (size < 0 || size > MAX_ITEMS || length * size > MAX_ITEMS) return fail();
          length *= size;
        }
        count(length);
        if (arrayType >= 3) {
          for (let dimension = 0; dimension < rank; dimension++) if (int() !== 0) return fail();
        }
        return arrayValues(id, length, memberType(byte()), depth);
      }
      case 8:
        return primitive(byte());
      case 9: {
        const reference = int();
        references.push(reference);
        return { reference };
      }
      case 10:
        return null;
      case 11:
        return END;
      case 13:
        return { nulls: byte() };
      case 14:
        return { nulls: int() };
      case 15:
      case 16:
      case 17: {
        const id = int();
        const length = count(int());
        return arrayValues(id, length, tag === 15 ? { type: 0, primitive: byte() } : { type: tag === 17 ? 1 : 2 }, depth);
      }
      default:
        return fail();
    }
  };
  if (bytes.length < 17 || bytes.length > 8 * 1024 * 1024 || byte() !== 0) return fail();
  const rootId = int();
  int();
  if (int() !== 1 || int() !== 0) return fail();
  while (record(0) !== END) {
  }
  const root = objects.get(rootId);
  if (root === void 0 || references.some((id) => !objects.has(id))) return fail();
  return { root, objects, consumed: offset };
}
function dereferenceNrbf(value, objects) {
  const visited = /* @__PURE__ */ new Set();
  while (value && typeof value === "object" && "reference" in value) {
    if (visited.has(value.reference)) throw new Error("RDO \u5305\u542B\u5FAA\u73AF\u5BF9\u8C61\u5F15\u7528");
    visited.add(value.reference);
    value = objects.get(value.reference);
  }
  return value;
}
function isNrbfObject(value) {
  return !!value && typeof value === "object" && "members" in value;
}

// src/main/services/rdo-password.ts
import { createDecipheriv, createHash } from "node:crypto";
import { TextDecoder as TextDecoder2 } from "node:util";
var formatPassword = "swevA2t62We?5Cr+he4Tac?_E!redafa?re5+2huv*$rU9eS8Ub4?W!!R+s7uthU";
var salt = Buffer.from("Ivan Medvedev", "ascii");
var sha1 = (value) => createHash("sha1").update(value).digest();
var base = sha1(Buffer.concat([Buffer.from(formatPassword, "utf8"), salt]));
for (let iteration = 1; iteration < 99; iteration++) base = sha1(base);
var blocks = [base, Buffer.concat([Buffer.from("1"), base]), Buffer.concat([Buffer.from("2"), base])].map(sha1);
var key = Buffer.concat(blocks.slice(0, 2)).subarray(0, 32);
var iv = Buffer.concat([blocks[0].subarray(8, 16), blocks[2].subarray(0, 8)]);
var unicode = new TextDecoder2("utf-16le", { fatal: true, ignoreBOM: true });
function decryptRdoPassword(value) {
  if (!value || value.length > 16384 || value.length % 32 || !/^[\da-f]+$/i.test(value)) return void 0;
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    plaintext = Buffer.concat([decipher.update(Buffer.from(value, "hex")), decipher.final()]);
    if (plaintext.length % 2) return void 0;
    const result = unicode.decode(plaintext);
    return result && !result.includes("\0") ? result : void 0;
  } catch {
    return void 0;
  } finally {
    plaintext?.fill(0);
  }
}

// src/main/services/rdo-import.ts
function parseRdo(bytes, existing = []) {
  const decoded = decodeNrbf(bytes);
  if (decoded.consumed !== bytes.length || !isNrbfObject(decoded.root) || decoded.root.type !== "RDO.Data.Types.Root") {
    throw new Error("\u4E0D\u662F\u53D7\u652F\u6301\u7684 Remote Desktop Organizer \u914D\u7F6E\u6587\u4EF6");
  }
  const resolve = (value) => dereferenceNrbf(value, decoded.objects);
  const member = (object, name) => resolve(object.members.get(name));
  const text = (object, name) => {
    const value = member(object, name);
    return typeof value === "string" ? value : "";
  };
  const items = (value) => {
    const object = resolve(value);
    if (Array.isArray(object)) return object;
    if (!isNrbfObject(object) || object.type !== "System.Collections.ArrayList") throw new Error("RDO \u8282\u70B9\u5217\u8868\u683C\u5F0F\u4E0D\u53D7\u652F\u6301");
    const entries = member(object, "_items");
    const size = member(object, "_size");
    if (!Array.isArray(entries) || typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > entries.length) {
      throw new Error("RDO \u8282\u70B9\u5217\u8868\u5DF2\u635F\u574F");
    }
    return entries.slice(0, size);
  };
  const guid = (value) => {
    const object = resolve(value);
    if (typeof object === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(object)) return object.toLowerCase().replaceAll("-", "");
    if (!isNrbfObject(object) || object.type !== "System.Guid") return void 0;
    const names = ["_a", "_b", "_c", "_d", "_e", "_f", "_g", "_h", "_i", "_j", "_k"];
    const values = names.map((name) => member(object, name));
    if (values.some((value2) => typeof value2 !== "number" || !Number.isInteger(value2))) return void 0;
    return values.map((value2, index) => (index === 0 ? value2 >>> 0 : value2 & (index < 3 ? 65535 : 255)).toString(16).padStart(index === 0 ? 8 : index < 3 ? 4 : 2, "0")).join("");
  };
  const identities = /* @__PURE__ */ new Map();
  const sections = items(decoded.root.members.get("Nodes")).map(resolve);
  for (const section of sections) {
    if (!isNrbfObject(section) || section.type !== "RDO.Data.Types.IdCards") continue;
    for (const entry of items(section.members.get("Nodes")).map(resolve)) {
      if (!isNrbfObject(entry) || entry.type !== "RDO.Data.Types.IdCard") continue;
      const id = guid(entry.members.get("ID"));
      if (id && identities.has(id)) throw new Error("RDO \u4E2D\u5B58\u5728\u91CD\u590D\u7684\u8EAB\u4EFD\u5361\u6807\u8BC6\uFF0C\u8BF7\u5148\u5728\u539F\u8F6F\u4EF6\u6574\u7406\u540E\u5BFC\u5165");
      if (id) identities.set(id, entry);
    }
  }
  const candidates = [];
  const credentials = /* @__PURE__ */ new Map();
  const known = new Set(existing.map(connectionKey));
  const visited = /* @__PURE__ */ new Set();
  const secrets = /* @__PURE__ */ new Map();
  let groups = 0;
  let missingIdentities = 0;
  let unreadablePasswords = 0;
  let gatewayConnections = 0;
  let credsspDisabled = 0;
  const visit = (value, path, depth) => {
    const object = resolve(value);
    if (!isNrbfObject(object) || depth > 32 || visited.has(object)) throw new Error("RDO \u76EE\u5F55\u7ED3\u6784\u65E0\u6548\u6216\u5B58\u5728\u5FAA\u73AF\u5F15\u7528");
    visited.add(object);
    if (object.type === "RDO.Data.Types.Folder" || object.type === "RDO.Data.Types.Connections") {
      const nextPath = object.type.endsWith(".Folder") ? [...path, text(object, "Text").trim() || "\u672A\u547D\u540D\u5206\u7EC4"] : path;
      if (object.type.endsWith(".Folder")) groups++;
      for (const child of items(object.members.get("Nodes"))) visit(child, nextPath, depth + 1);
      return;
    }
    if (object.type !== "RDO.Data.Types.RemoteDesktop") throw new Error("RDO \u5305\u542B\u6682\u4E0D\u652F\u6301\u7684\u8FDE\u63A5\u7C7B\u578B");
    if (candidates.length >= 1e4) throw new Error("RDO \u8FDE\u63A5\u6570\u91CF\u8D85\u8FC7\u5BFC\u5165\u4E0A\u9650");
    const useIdentity = member(object, "UseIdCard") === true;
    const identityId = guid(object.members.get("IdCardGuid"));
    const identity = useIdentity && identityId ? identities.get(identityId) : void 0;
    if (useIdentity && !identity) missingIdentities++;
    const source = useIdentity ? identity : object;
    const username = source ? text(source, "User").trim() : "";
    const encrypted = source ? text(source, "Password") : "";
    if (encrypted && !secrets.has(encrypted)) secrets.set(encrypted, decryptRdoPassword(encrypted));
    const secret = secrets.get(encrypted);
    if (encrypted && !secret) unreadablePasswords++;
    const host = text(object, "Host").trim();
    const rawPort = member(object, "Port");
    const port = rawPort === void 0 || rawPort === null ? 3389 : typeof rawPort === "number" ? rawPort : Number(rawPort);
    const invalidPort = !Number.isInteger(port) || port < 1 || port > 65535;
    const gateway = member(object, "GatewayUsage");
    const needsGateway = gateway !== void 0 && gateway !== null && gateway !== 0;
    if (needsGateway) gatewayConnections++;
    if (member(object, "EnableCredSspSupport") === false) credsspDisabled++;
    const options = { dynamicResolution: true, enableClipboard: true, ignoreCertificate: true };
    const switches = [
      ["SmartSize", "systemSmartSizing"],
      ["AllowWallpaper", "showWallpaper"],
      ["AllowContents", "showDraggedWindow"],
      ["AllowAnimation", "showMenuAnimations"],
      ["AllowThemes", "showThemes"]
    ];
    for (const [sourceName, targetName] of switches) {
      const setting = member(object, sourceName);
      if (typeof setting === "boolean") options[targetName] = setting;
    }
    const colorDepth = member(object, "ColorDepth");
    if (colorDepth === 16 || colorDepth === 24 || colorDepth === 32) options.colorDepth = colorDepth;
    const audio = member(object, "AudioSetting");
    if (audio === 0 || audio === 1 || audio === 2) options.audioCaptureMode = audio === 0 ? "local" : audio === 1 ? "remote" : "none";
    const authentication = member(object, "AuthenticationLevel");
    if (authentication === 1 || authentication === 2) options.ignoreCertificate = false;
    const tempId = randomUUID2();
    if (secret) credentials.set(tempId, { secret });
    const duplicate = !!host && known.has(connectionKey({ kind: "rdp", host, port }));
    if (host) known.add(connectionKey({ kind: "rdp", host, port }));
    candidates.push({
      tempId,
      kind: "rdp",
      name: text(object, "Text").trim() || host || "\u672A\u547D\u540D\u8FDE\u63A5",
      host,
      port,
      username,
      domain: text(object, "Domain").trim() || void 0,
      group: path.join(" / ") || void 0,
      note: text(object, "Description") || void 0,
      credentialAvailable: !!secret,
      authMethod: "password",
      credentialName: identity ? text(identity, "Text") || void 0 : void 0,
      requiresReview: needsGateway || invalidPort,
      reviewReason: needsGateway ? "\u6E90\u914D\u7F6E\u4F7F\u7528 RD Gateway\uFF0C\u7F51\u5173\u914D\u7F6E\u672A\u8FC1\u79FB\uFF0C\u8BF7\u6838\u5BF9\u8FDE\u63A5\u8DEF\u5F84" : invalidPort ? "\u6E90\u914D\u7F6E\u7AEF\u53E3\u65E0\u6548\uFF0C\u8BF7\u4FEE\u6B63" : void 0,
      rdpOptions: options,
      hostInferred: false,
      usernameMissing: !username,
      sourceTitle: text(object, "Text"),
      duplicate
    });
  };
  const connectionSections = sections.filter((section) => isNrbfObject(section) && section.type === "RDO.Data.Types.Connections");
  if (!connectionSections.length) throw new Error("RDO \u6587\u4EF6\u4E2D\u6CA1\u6709\u627E\u5230\u8FDE\u63A5\u5217\u8868");
  for (const section of connectionSections) visit(section, [], 0);
  const warnings = [];
  if (unreadablePasswords) warnings.push(`${unreadablePasswords} \u6761\u8FDE\u63A5\u7684\u5BC6\u7801\u683C\u5F0F\u65E0\u6CD5\u89E3\u5BC6\uFF0C\u672A\u5C06\u5BC6\u6587\u5F53\u4F5C\u5BC6\u7801\u5BFC\u5165\uFF1B\u53EF\u5BFC\u5165\u914D\u7F6E\u540E\u8865\u586B\u6216\u9009\u62E9\u516C\u5171\u51ED\u636E\u3002`);
  if (missingIdentities) warnings.push(`${missingIdentities} \u6761\u8FDE\u63A5\u5F15\u7528\u7684\u8EAB\u4EFD\u5361\u4E0D\u5B58\u5728\uFF0C\u8D26\u53F7\u53CA\u5BC6\u7801\u9700\u8865\u5145\u3002`);
  if (gatewayConnections) warnings.push(`${gatewayConnections} \u6761\u8FDE\u63A5\u4F7F\u7528 RD Gateway\uFF0C\u7F51\u5173\u914D\u7F6E\u6682\u4E0D\u8FC1\u79FB\uFF1B\u8FD9\u4E9B\u8FDE\u63A5\u9ED8\u8BA4\u4E0D\u52FE\u9009\uFF0C\u8BF7\u6838\u5BF9\u540E\u518D\u5BFC\u5165\u3002`);
  if (credsspDisabled) warnings.push(`${credsspDisabled} \u6761\u6E90\u914D\u7F6E\u5173\u95ED\u4E86 CredSSP\u3002\u4E0D\u4F1A\u7167\u642C\u5B89\u5168\u964D\u7EA7\u8BBE\u7F6E\uFF1B\u5BFC\u5165\u914D\u7F6E\u4E0D\u7B49\u4E8E\u5185\u7F6E RDP \u5DF2\u517C\u5BB9\u65E7\u7248\u5B89\u5168\u5C42\uFF0C\u5FC5\u8981\u65F6\u8BF7\u4F7F\u7528\u7CFB\u7EDF\u5BA2\u6237\u7AEF\u3002`);
  return { candidates, credentials, groups, warnings };
}
export {
  candidateToConnection,
  parseRdo,
  parseXTerminalRecords
};
