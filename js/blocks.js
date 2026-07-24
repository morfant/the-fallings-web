// 블럭 더미(Pile) — 낙하/적층/생애주기 관리.
//
// 물리 월드에는 항상 "표면(static) 1개 + 낙하 중인 블럭 최대 1개"만 존재한다.
// 착지한 블럭은 바디를 제거하고 스택 인덱스로만 렌더(결정론적 y) —
// 수년치가 쌓여도 물리 비용이 상수로 유지된다.
//
// 좌표계: GROUND_Y가 바닥. 블럭 i(0=최하단)의 중심 y = GROUND_Y - (i+0.5)*BLOCK_H.

class Pile {
    constructor(engine, worldW) {
        this.engine = engine;
        this.worldW = worldW;
        this.settled = [];   // { victimIdx, settledAt(ms, 0=프리스택) }
        this.falling = null; // { victimIdx, body }

        const { Bodies, World } = Matter;
        this.surface = Bodies.rectangle(
            worldW / 2, CONFIG.GROUND_Y + 50, worldW * 2, 100,
            { isStatic: true, friction: 1 }
        );
        World.add(engine.world, this.surface);
    }

    blockW() { return Math.max(60, this.worldW - CONFIG.BLOCK_MARGIN * 2); }

    // 더미 꼭대기 표면의 월드 y (블럭 없으면 바닥)
    topY() { return CONFIG.GROUND_Y - this.settled.length * CONFIG.BLOCK_H; }

    yOfCenter(i) { return CONFIG.GROUND_Y - (i + 0.5) * CONFIG.BLOCK_H; }

    indexAtWorldY(y) {
        const i = Math.floor((CONFIG.GROUND_Y - y) / CONFIG.BLOCK_H);
        return i >= 0 && i < this.settled.length ? i : -1;
    }

    // 과거분을 물리 없이 즉시 적층
    prestack(victimIndices) {
        for (const vi of victimIndices) {
            this.settled.push({ victimIdx: vi, settledAt: 0 });
        }
        this._syncSurface();
    }

    spawn(victimIdx, spawnY) {
        const { Bodies, Body, World } = Matter;
        const body = Bodies.rectangle(
            this.worldW / 2, spawnY, this.blockW(), CONFIG.BLOCK_H,
            {
                friction: 1,
                frictionStatic: 10,
                restitution: 0.05,
                density: 0.002,
            }
        );
        Body.setInertia(body, Infinity); // 회전 금지 — 수평 낙하/착지 보장
        World.add(this.engine.world, body);
        this.falling = { victimIdx, body };
    }

    // draw 루프마다 호출. 착지 시 settled로 옮기고 victimIdx 반환, 아니면 null.
    update(nowMs) {
        if (!this.falling) return null;
        const b = this.falling.body;
        const surfaceTop = this.topY();
        const restingY = surfaceTop - CONFIG.BLOCK_H / 2;
        const nearSurface = b.position.y >= restingY - 1.5;
        const slow = Math.abs(b.velocity.y) < 0.25;

        if ((nearSurface && slow) || b.position.y > restingY + CONFIG.BLOCK_H) {
            Matter.World.remove(this.engine.world, b);
            this.settled.push({ victimIdx: this.falling.victimIdx, settledAt: nowMs });
            this.falling = null;
            this._syncSurface();
            return this.settled[this.settled.length - 1].victimIdx;
        }
        return null;
    }

    _syncSurface() {
        Matter.Body.setPosition(this.surface, {
            x: this.worldW / 2,
            y: this.topY() + 50,
        });
    }

    resize(worldW) {
        this.worldW = worldW;
        Matter.Body.setPosition(this.surface, { x: worldW / 2, y: this.topY() + 50 });
        // 낙하 중이던 블럭은 새 폭으로 다시 스폰
        if (this.falling) {
            const { victimIdx, body } = this.falling;
            const y = body.position.y;
            Matter.World.remove(this.engine.world, body);
            this.falling = null;
            this.spawn(victimIdx, y);
        }
    }

    // 뷰포트에 보이는 settled 인덱스 범위 [lo, hi]
    visibleRange(cameraY, viewportH) {
        const H = CONFIG.BLOCK_H;
        const lo = Math.max(0, Math.floor((CONFIG.GROUND_Y - (cameraY + viewportH)) / H) - 1);
        const hi = Math.min(this.settled.length - 1, Math.ceil((CONFIG.GROUND_Y - cameraY) / H) + 1);
        return [lo, hi];
    }
}
