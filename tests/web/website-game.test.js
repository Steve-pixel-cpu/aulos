// Aulos Dig regressions: run the shipped game helpers and world generator.
// No renderer or browser dependency, so CI can run this file with Node alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const WEBSITE = path.join(__dirname, "..", "..", "website");
const worldgen = require(path.join(WEBSITE, "js", "worldgen.js"));

function targeting() {
  const element = { addEventListener() {}, querySelector() { return element; } };
  const context = {
    window: {
      addEventListener() {},
      __TILES_META__: JSON.parse(fs.readFileSync(path.join(WEBSITE, "assets/mc/tiles.json"), "utf8")),
    },
    document: { getElementById() { return element; }, addEventListener() {} },
    Phaser: { Scene: function () {} },
    location: { hash: "" },
  };
  // Expose the private helper only in this VM, without adding a production API.
  const source = fs.readFileSync(path.join(WEBSITE, "js/game2.js"), "utf8");
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    window.testTargeting = { digAt: digAt, setWorld: function (w) { world = w; } };
  })();`), context);
  const world = { tile: new Uint8Array(512 * 256) };
  context.window.testTargeting.setWorld(world);
  const scene = {
    player: { x: 10 * 32 + 16, y: 10 * 32 + 16 },
    cameras: { main: { getWorldPoint: (x, y) => ({ x, y }) } },
  };
  return {
    world, scene,
    at(x, y) {
      context.window.testTargeting.digAt(scene, { x: x * 32 + 16, y: y * 32 + 16 });
      return scene.digTarget;
    },
  };
}

test("nearby air leaves the pointer available for shooting", () => {
  const game = targeting();
  assert.equal(game.at(11, 10), null);
});

test("nearby breakable blocks remain dig targets", () => {
  const game = targeting();
  for (const id of [worldgen.TILE.DIRT, worldgen.TILE.CRYSTAL, worldgen.TILE.TORCH]) {
    game.world.tile[10 * 512 + 11] = id;
    assert.deepEqual({ ...game.at(11, 10) }, { x: 11, y: 10 });
  }
});

test("unbreakable and distant blocks do not consume a shooting click", () => {
  const game = targeting();
  game.world.tile[10 * 512 + 11] = worldgen.TILE.BEDROCK;
  assert.equal(game.at(11, 10), null);
  game.world.tile[10 * 512 + 17] = worldgen.TILE.DIRT;
  assert.equal(game.at(17, 10), null);
});

test("targeting outside world bounds cannot wrap onto another row", () => {
  const game = targeting();
  for (const [x, y] of [[-1, 10], [512, 10], [10, -1], [10, 256]]) {
    game.scene.player.x = x * 32 + 16;
    game.scene.player.y = y * 32 + 16;
    const index = y * 512 + x;
    if (index >= 0 && index < game.world.tile.length) game.world.tile[index] = worldgen.TILE.DIRT;
    assert.equal(game.at(x, y), null, `out-of-bounds tile (${x}, ${y})`);
  }
});

for (const seed of [3, 8, 13]) {
  test(`reachability repair preserves visible chests (seed ${seed})`, () => {
    const world = worldgen.generate(seed, 512, 256);
    assert.equal(world.chests.length, 4);
    for (const [x, y] of world.chests) {
      assert.equal(world.tile[y * world.W + x], worldgen.TILE.CHEST, `chest at (${x}, ${y})`);
    }
  });
}
