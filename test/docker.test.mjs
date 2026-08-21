import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDockerClient,
  deskContainerSpec,
  deskContainerName,
  deskAlias,
  dataRootFromInspect,
  templateNetwork,
  ensureDeskContainer,
  removeDeskContainer,
  DESK_LABEL,
  DOCKER_REMOVE_MS,
  DOCKER_REQUEST_MS,
} from "../lib/docker.mjs";

const TEMPLATE = {
  Id: "tpl",
  Name: "/gpt-pro-cloud-a",
  State: { Running: true },
  Config: {
    Image: "gpt-pro-cloud-desktop:local",
    Env: [
      "PUID=1000",
      "PGID=1000",
      "TZ=Asia/Shanghai",
      "CUSTOM_USER=abc",
      "PASSWORD=gpc-internal",
      "TITLE=GPT Pro",
      "START_URL=https://chatgpt.com",
      "PROXY_URL=",
      "LIBGL_ALWAYS_SOFTWARE=1",
      "PROXY_URL_OVERRIDE=socks5://10.0.0.2:1080",
    ],
    Labels: {
      "com.docker.compose.project": "gpt-pro-cloud",
      "com.docker.compose.service": "desktop-a",
    },
  },
  HostConfig: {
    ExtraHosts: ["host.docker.internal:host-gateway"],
    ShmSize: 1073741824,
    RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    NetworkMode: "gpt-pro-cloud_default",
  },
  NetworkSettings: {
    Networks: {
      "gpt-pro-cloud_default": {
        NetworkID: "net1",
        Aliases: ["desktop-a", "gpt-pro-cloud-a"],
      },
    },
  },
  Mounts: [{ Type: "bind", Source: "/srv/gpt-pro-cloud/data/a", Destination: "/config" }],
};

describe("deskContainerSpec", () => {
  it("clones image, network alias, data dir and strips A's proxy override", () => {
    assert.equal(DOCKER_REMOVE_MS <= DOCKER_REQUEST_MS, true);
    assert.equal(DOCKER_REMOVE_MS <= 10_000, true);
    assert.equal(dataRootFromInspect(TEMPLATE), "/srv/gpt-pro-cloud/data");
    assert.equal(templateNetwork(TEMPLATE), "gpt-pro-cloud_default");
    const { name, body } = deskContainerSpec("c", TEMPLATE);
    assert.equal(name, "gpt-pro-cloud-c");
    assert.equal(deskContainerName("c"), name);
    assert.equal(deskAlias("c"), "desktop-c");
    assert.equal(body.Image, "gpt-pro-cloud-desktop:local");
    assert.deepEqual(body.HostConfig.Binds, ["/srv/gpt-pro-cloud/data/c:/config"]);
    assert.equal(body.HostConfig.RestartPolicy.Name, "unless-stopped");
    assert.equal(body.HostConfig.ShmSize, 1073741824);
    assert.deepEqual(body.NetworkingConfig.EndpointsConfig["gpt-pro-cloud_default"].Aliases, ["desktop-c"]);
    assert.equal(body.Labels[DESK_LABEL], "c");
    assert.ok(body.Env.includes("PROXY_URL_OVERRIDE="));
    assert.ok(body.Env.includes("ENABLE_CDP="));
    assert.equal(body.Env.includes("ENABLE_CDP=1"), false);
    assert.equal(
      body.Env.some((e) => e.startsWith("PROXY_URL_OVERRIDE=") && e !== "PROXY_URL_OVERRIDE="),
      false,
    );
    assert.ok(!body.Labels["com.docker.compose.service"]);
  });

  it("does not copy a template ENABLE_CDP=1 onto a new desk unless asked", () => {
    const inspect = {
      ...TEMPLATE,
      Config: { ...TEMPLATE.Config, Env: [...TEMPLATE.Config.Env, "ENABLE_CDP=1", "TAB_SEATS=1"] },
    };
    const off = deskContainerSpec("c", inspect);
    assert.ok(off.body.Env.includes("ENABLE_CDP="));
    assert.equal(off.body.Env.includes("ENABLE_CDP=1"), false);
    assert.equal(off.body.Env.some((e) => e.startsWith("TAB_SEATS=")), false);
    const on = deskContainerSpec("c", inspect, { enableCdp: true });
    assert.ok(on.body.Env.includes("ENABLE_CDP=1"));
    assert.equal(on.body.Env.includes("ENABLE_CDP="), false);
  });
});

function startMockDocker({ existing = null, failCreate = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gpc-dock-"));
  const socketPath = join(dir, "docker.sock");
  const state = { created: [], started: [], connected: [], removed: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://docker.local");
    const path = url.pathname.replace(/^\/v1\.\d+/, "");
    const send = (code, body) => {
      if (body === undefined) {
        res.writeHead(code);
        res.end();
        return;
      }
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && path === "/containers/gpt-pro-cloud-a/json") {
      send(200, TEMPLATE);
      return;
    }
    if (req.method === "GET" && path.startsWith("/containers/") && path.endsWith("/json")) {
      if (existing && path === `/containers/${existing.Name.replace(/^\//, "")}/json`) {
        send(200, existing);
        return;
      }
      send(404, { message: "No such container" });
      return;
    }
    if (req.method === "POST" && path === "/containers/create") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (failCreate) {
          send(500, { message: "engine exploded" });
          return;
        }
        state.created.push({ name: url.searchParams.get("name"), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        send(201, { Id: "newid" });
      });
      return;
    }
    if (req.method === "POST" && /\/containers\/.+\/start$/.test(path)) {
      state.started.push(path);
      send(204);
      return;
    }
    if (req.method === "DELETE" && path.startsWith("/containers/")) {
      state.removed.push(path);
      send(204);
      return;
    }
    if (req.method === "POST" && /\/networks\/.+\/connect$/.test(path)) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        state.connected.push({ path, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
        send(200, {});
      });
      return;
    }
    send(404, { message: `unhandled ${req.method} ${path}` });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ server, socketPath, state }));
  });
}

describe("ensureDeskContainer", () => {
  it("creates and starts a sibling of desktop-a", async () => {
    const mock = await startMockDocker();
    try {
      const client = createDockerClient({ socketPath: mock.socketPath, templateName: "gpt-pro-cloud-a" });
      const out = await ensureDeskContainer("c", client);
      assert.equal(out.created, true);
      assert.equal(out.name, "gpt-pro-cloud-c");
      assert.equal(mock.state.created.length, 1);
      assert.equal(mock.state.created[0].name, "gpt-pro-cloud-c");
      assert.deepEqual(mock.state.created[0].body.NetworkingConfig.EndpointsConfig["gpt-pro-cloud_default"].Aliases, [
        "desktop-c",
      ]);
      assert.equal(mock.state.started.length, 1);
    } finally {
      mock.server.close();
    }
  });

  it("starts and reconnects an existing stopped extra desk", async () => {
    const existing = {
      Name: "/gpt-pro-cloud-c",
      State: { Running: false },
      NetworkSettings: { Networks: {} },
    };
    const mock = await startMockDocker({ existing });
    try {
      const client = createDockerClient({ socketPath: mock.socketPath });
      const out = await ensureDeskContainer("c", client);
      assert.equal(out.created, false);
      assert.equal(mock.state.created.length, 0);
      assert.equal(mock.state.connected.length, 1);
      assert.deepEqual(mock.state.connected[0].body.EndpointConfig.Aliases, ["desktop-c"]);
      assert.equal(mock.state.started.length, 1);
    } finally {
      mock.server.close();
    }
  });

  it("maps a missing docker socket to a 503", async () => {
    const client = createDockerClient({ socketPath: join(tmpdir(), "gpc-no-such-docker.sock") });
    await assert.rejects(() => ensureDeskContainer("c", client), (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /docker\.sock/);
      return true;
    });
  });

  it("does not treat a create failure as success", async () => {
    const mock = await startMockDocker({ failCreate: true });
    try {
      const client = createDockerClient({ socketPath: mock.socketPath });
      await assert.rejects(() => ensureDeskContainer("c", client), /engine exploded/);
    } finally {
      mock.server.close();
    }
  });
});

describe("removeDeskContainer", () => {
  it("force-removes the extra container and wipes the bind dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-wipe-"));
    const dataRoot = join(dir, "data");
    mkdirSync(join(dataRoot, "c"), { recursive: true });
    writeFileSync(join(dataRoot, "c", "Cookies"), "login");
    const existing = {
      Name: "/gpt-pro-cloud-c",
      State: { Running: true },
      Mounts: [{ Destination: "/config", Source: join(dataRoot, "c") }],
    };
    const mock = await startMockDocker({ existing });
    try {
      const client = createDockerClient({ socketPath: mock.socketPath });
      const out = await removeDeskContainer("c", client);
      assert.equal(out.name, "gpt-pro-cloud-c");
      assert.equal(out.wiped, true);
      assert.equal(out.how, "fs");
      assert.equal(existsSync(join(dataRoot, "c")), false);
      assert.ok(mock.state.removed.some((p) => p.includes("gpt-pro-cloud-c")));
    } finally {
      mock.server.close();
    }
  });
});
