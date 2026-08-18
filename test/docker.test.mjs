import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
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
  DESK_LABEL,
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
    assert.equal(
      body.Env.some((e) => e.startsWith("PROXY_URL_OVERRIDE=") && e !== "PROXY_URL_OVERRIDE="),
      false,
    );
    assert.ok(!body.Labels["com.docker.compose.service"]);
  });
});

function startMockDocker({ existing = null, failCreate = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gpc-dock-"));
  const socketPath = join(dir, "docker.sock");
  const state = { created: [], started: [], connected: [] };
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
