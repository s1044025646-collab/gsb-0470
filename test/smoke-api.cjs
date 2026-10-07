// API 冒烟脚本：node test/smoke-api.cjs
const { Store } = require("../dist/src/store");
const { createServer, listen } = require("../dist/src/server");

(async () => {
  const store = new Store(":memory:");
  const server = createServer(store);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, b, h) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(h || {}) },
      body: JSON.stringify(b),
    });
    return r.json();
  };
  console.log("PORT", port);
  await post("/axes", { id: "S" });
  await post("/axes", { id: "R" });
  await post("/axes", { id: "C" });
  await post("/gearsets", { id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "C" });
  await post("/fixed", { id: "f1", axis: "S", value: "1200" });
  const r = await post("/fixed", { id: "f2", axis: "R", value: { num: 0, den: 7 } });
  console.log("C =", JSON.stringify(r.data.solution.find((x) => x.axis === "C")));
  const i1 = await post("/axes", { id: "X" }, { "Idempotency-Key": "k9" });
  const i2 = await post("/axes", { id: "X" }, { "Idempotency-Key": "k9" });
  console.log("idem equal:", JSON.stringify(i1) === JSON.stringify(i2));
  const bad = await post("/fixed", { id: "f3", axis: "NOPE", value: "1" });
  console.log("bad ref code:", bad.error.code);
  const eq = await (await fetch(base + "/equations")).json();
  console.log("equations:", eq.data.map((e) => e.description).join(" | "));
  const rep = await (await fetch(base + "/report")).json();
  console.log("report version:", rep.data.version, "status:", rep.data.result.status);
  server.close();
  store.close();
})();
