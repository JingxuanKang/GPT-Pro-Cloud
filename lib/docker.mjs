/**
 * Hypothesis: cloning gpt-pro-cloud-a via the Engine API (same image,
 * compose-network alias desktop-<id>, bind ./data/<id>:/config) is enough
 * for the gateway proxy at http://desktop-<id>:3000. Extra desks are not
 * compose services; omitting compose labels keeps `docker compose down`
 * from deleting them. Reconcile reconnects them to the current network.
 */
import http from "node:http";
import { dirname } from "node:path";

export const DOCKER_API = "/v1.41";
export const DESK_LABEL = "gpt-pro-cloud.desk";

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
export function deskContainerSpec(id, inspect) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw dockerError("账号 id 不合法", 400);
  const image = inspect?.Config?.Image;
  if (!image) throw dockerError("模板桌面没有镜像名");
  const dataRoot = dataRootFromInspect(inspect);
  const network = templateNetwork(inspect);
  const env = (inspect.Config?.Env || []).filter((e) => !String(e).startsWith("PROXY_URL_OVERRIDE="));
  env.push("PROXY_URL_OVERRIDE=");
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
  };
}

export async function ensureDeskContainer(id, client) {
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
  const { name, body } = deskContainerSpec(id, template);
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
