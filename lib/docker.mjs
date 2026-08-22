/**
 * Hypothesis: cloning gpt-pro-cloud-a via the Engine API (same image,
 * compose-network alias desktop-<id>, bind ./data/<id>:/config) is enough
 * for the gateway proxy at http://desktop-<id>:3000. Extra desks are not
 * compose services; omitting compose labels keeps `docker compose down`
 * from deleting them. Reconcile reconnects them to the current network.
 */
import http from "node:http";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const DOCKER_API = "/v1.41";
export const DESK_LABEL = "gpt-pro-cloud.desk";
export const DOCKER_REQUEST_MS = 20_000;

export function deskContainerName(id) {
  return `gpt-pro-cloud-${id}`;
}

export function deskAlias(id) {
  return `desktop-${id}`;
}

export function dockerError(message, status = 502, cause) {
  const e = new Error(message);
  e.status = status;
  if (cause) e.cause = cause;
  return e;
}

export function dataRootFromInspect(inspect) {
  const mounts = inspect?.Mounts || [];
  const m = mounts.find((x) => x.Destination === "/config" || x.Destination === "/config/");
  if (!m?.Source) throw dockerError("模板桌面没有 /config 卷，无法为新账号准备数据目录");
  return dirname(m.Source);
}

export function templateNetwork(inspect) {
  const nets = inspect?.NetworkSettings?.Networks || {};
  const name = Object.keys(nets)[0];
  if (!name) throw dockerError("模板桌面不在任何 Docker 网络上");
  return name;
}

/** Build Engine API create-body by cloning desktop-a. */
export function deskContainerSpec(id, inspect, { enableCdp = false } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw dockerError("账号 id 不合法", 400);
  const image = inspect?.Config?.Image;
  if (!image) throw dockerError("模板桌面没有镜像名");
  const dataRoot = dataRootFromInspect(inspect);
  const network = templateNetwork(inspect);
  const env = (inspect.Config?.Env || []).filter(
    (e) =>
      !String(e).startsWith("PROXY_URL_OVERRIDE=") &&
      !String(e).startsWith("ENABLE_CDP=") &&
      !String(e).startsWith("TAB_SEATS="),
  );
  env.push("PROXY_URL_OVERRIDE=");
  env.push(enableCdp ? "ENABLE_CDP=1" : "ENABLE_CDP=");
  const extraHosts = inspect.HostConfig?.ExtraHosts?.length
    ? [...inspect.HostConfig.ExtraHosts]
    : ["host.docker.internal:host-gateway"];
  return {
    name: deskContainerName(id),
    body: {
      Image: image,
      Env: env,
      Labels: {
        [DESK_LABEL]: id,
        "gpt-pro-cloud.role": "desktop",
      },
      HostConfig: {
        Binds: [`${dataRoot}/${id}:/config`],
        ExtraHosts: extraHosts,
        ShmSize: inspect.HostConfig?.ShmSize || 1073741824,
        RestartPolicy: { Name: "unless-stopped" },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [network]: { Aliases: [deskAlias(id)] },
        },
      },
    },
  };
}

function readRes(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

export function createDockerClient({ socketPath = "/var/run/docker.sock", templateName = "gpt-pro-cloud-a" } = {}) {
  const request = (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          socketPath,
          path: path.startsWith("/v1.") ? path : `${DOCKER_API}${path}`,
          method,
          headers: {
            host: "docker",
            accept: "application/json",
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        async (res) => {
          try {
            const raw = await readRes(res);
            let json = null;
            if (raw) {
              try {
                json = JSON.parse(raw);
              } catch {
                json = { message: raw };
              }
            }
            if (res.statusCode >= 400) {
              const msg = json?.message || raw || `docker ${res.statusCode}`;
              reject(dockerError(msg, res.statusCode >= 500 ? 502 : res.statusCode));
              return;
            }
            resolve(json);
          } catch (e) {
            reject(e);
          }
        },
      );
      req.on("error", (err) => {
        if (err.code === "ENOENT") {
          reject(
            dockerError(
              "网关没有 Docker 权限。请把 /var/run/docker.sock 挂进 gateway 后执行 docker compose up -d（见 Deploy.md）",
              503,
              err,
            ),
          );
          return;
        }
        reject(dockerError(err.message || "无法连接 Docker", 502, err));
      });
      if (payload) req.write(payload);
      req.end();
    });

  return {
    socketPath,
    templateName,
    request,
    async inspect(name) {
      return request("GET", `/containers/${encodeURIComponent(name)}/json`);
    },
    async create(name, body) {
      return request("POST", `/containers/create?name=${encodeURIComponent(name)}`, body);
    },
    async start(name) {
      return request("POST", `/containers/${encodeURIComponent(name)}/start`);
    },
    async connectNetwork(network, container, aliases) {
      return request("POST", `/networks/${encodeURIComponent(network)}/connect`, {
        Container: container,
        EndpointConfig: { Aliases: aliases },
      });
    },
    async remove(name) {
      return request("DELETE", `/containers/${encodeURIComponent(name)}?force=true&v=true`);
    },
    async wait(name) {
      return request("POST", `/containers/${encodeURIComponent(name)}/wait`);
    },
    async putArchive(name, destPath, tar) {
      const body = Buffer.isBuffer(tar) ? tar : Buffer.from(tar || []);
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: `${DOCKER_API}/containers/${encodeURIComponent(name)}/archive?path=${encodeURIComponent(destPath)}`,
            method: "PUT",
            headers: {
              host: "docker",
              "content-type": "application/x-tar",
              "content-length": body.length,
            },
          },
          async (res) => {
            try {
              const raw = await readRes(res);
              if (res.statusCode >= 400) {
                let msg = `docker ${res.statusCode}`;
                try {
                  msg = JSON.parse(raw)?.message || raw || msg;
                } catch {
                  if (raw) msg = raw;
                }
                reject(dockerError(msg, res.statusCode >= 500 ? 502 : res.statusCode));
                return;
              }
              resolve({ ok: true });
            } catch (e) {
              reject(e);
            }
          },
        );
        req.on("error", (err) => reject(dockerError(err.message || "无法连接 Docker", 502, err)));
        req.setTimeout(DOCKER_REQUEST_MS, () => {
          req.destroy();
          reject(dockerError("Docker 操作超时", 502));
        });
        req.write(body);
        req.end();
      });
    },
    async exec(name, cmd) {
      const created = await request("POST", `/containers/${encodeURIComponent(name)}/exec`, {
        AttachStdout: false,
        AttachStderr: false,
        Cmd: cmd,
      });
      if (!created?.Id) throw dockerError("无法在账号容器内清理上传文件");
      await request("POST", `/exec/${encodeURIComponent(created.Id)}/start`, { Detach: true, Tty: false });
      return { ok: true, id: created.Id };
    },
  };
}

export async function ensureDeskContainer(id, client, { enableCdp = false } = {}) {
  const templateName = client.templateName || "gpt-pro-cloud-a";
  let template;
  try {
    template = await client.inspect(templateName);
  } catch (e) {
    if (e.status === 404) {
      throw dockerError(`找不到模板桌面 ${templateName}。请先用 docker compose 启动 desktop-a`, 502, e);
    }
    throw e;
  }
  const { name, body } = deskContainerSpec(id, template, { enableCdp });
  const network = templateNetwork(template);
  let existing = null;
  try {
    existing = await client.inspect(name);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!existing) {
    try {
      await client.create(name, body);
    } catch (e) {
      if (e.status !== 409) throw e;
    }
    await client.start(name);
    return { created: true, started: true, name };
  }
  const nets = existing.NetworkSettings?.Networks || {};
  if (!nets[network]) {
    try {
      await client.connectNetwork(network, name, [deskAlias(id)]);
    } catch (e) {
      if (!/already|exists/i.test(e.message || "")) throw e;
    }
  }
  if (!existing.State?.Running) {
    await client.start(name);
  }
  return { created: false, started: true, name };
}

async function wipeDeskData(client, dataRoot, id) {
  const dir = join(dataRoot, id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    return { wiped: true, how: "fs" };
  }
  let image = "";
  try {
    const template = await client.inspect(client.templateName || "gpt-pro-cloud-a");
    image = template?.Config?.Image || "";
  } catch {
    /* no template — skip host wipe */
  }
  if (!image) return { wiped: false, how: "none" };
  const wipeName = `gpc-wipe-${id}`;
  try {
    await client.remove(wipeName);
  } catch {
    /* leftover from a previous wipe */
  }
  try {
    await client.create(wipeName, {
      Image: image,
      Entrypoint: ["rm"],
      Cmd: ["-rf", `/wipe/${id}`],
      HostConfig: {
        Binds: [`${dataRoot}:/wipe`],
        AutoRemove: true,
      },
    });
    await client.start(wipeName);
    try {
      await client.wait(wipeName);
    } catch {
      /* AutoRemove may already be gone */
    }
    return { wiped: true, how: "docker" };
  } catch {
    return { wiped: false, how: "none" };
  }
}

/** Invert ensureDeskContainer: force-remove the extra desk and wipe ./data/<id>. */
export async function removeDeskContainer(id, client) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw dockerError("账号 id 不合法", 400);
  const name = deskContainerName(id);
  let dataRoot = "";
  try {
    const inspect = await client.inspect(name);
    const mounts = inspect?.Mounts || [];
    const m = mounts.find((x) => x.Destination === "/config" || x.Destination === "/config/");
    if (m?.Source) dataRoot = dirname(m.Source);
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      const template = await client.inspect(client.templateName || "gpt-pro-cloud-a");
      dataRoot = dataRootFromInspect(template);
    } catch {
      /* still drop the container record */
    }
  }
  try {
    await client.remove(name);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const wipe = dataRoot ? await wipeDeskData(client, dataRoot, id) : { wiped: false, how: "none" };
  return { name, ...wipe };
}
