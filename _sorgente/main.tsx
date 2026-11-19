import * as React from "react"
import { createRoot } from "react-dom/client"
import LowPolyPoleScene from "./LowPolyPoleScene"

// ---------------------------------------------------------------------------
// Settings come from index.html (window.SCENE), so they can be changed
// without rebuilding this file.
// ---------------------------------------------------------------------------

type SceneSettings = Record<string, unknown> & {
    phoneMaxWidth?: number
    phone?: Record<string, unknown>
}

declare global {
    interface Window {
        SCENE?: SceneSettings
    }
}

// ---------------------------------------------------------------------------
// Tear-off tabs: same motion as the Framer component.
//   1. tap: the tab tilts to -10 degrees (critically damped spring, 0.2 s)
//   2. 100 ms later it falls: its box moves to 1387 px lower and grows to
//      90 x 400 px in 0.8 s, cubic-bezier(0.5, 0, 0.88, 0.77)
// The link opens as usual (same tab, it is a download).
// ---------------------------------------------------------------------------

const TILT_DEG = -10
const TILT_OMEGA = 46.2 // spring with bounce 0 and duration 0.2 s
const FALL_DELAY_MS = 104
const FALL_DURATION_MS = 800
const FALL_TOP = 1387
const FALL_WIDTH = 90
const FALL_HEIGHT = 400

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
    const bx = (t: number) =>
        3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
    const by = (t: number) =>
        3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
    return (x: number) => {
        if (x <= 0) return 0
        if (x >= 1) return 1
        let lo = 0
        let hi = 1
        for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2
            if (bx(mid) < x) lo = mid
            else hi = mid
        }
        return by((lo + hi) / 2)
    }
}

const fallEase = cubicBezier(0.5, 0, 0.88, 0.77)

function tearOff(tab: HTMLAnchorElement, body: HTMLElement) {
    if (tab.dataset.state) return
    tab.dataset.state = "torn"
    const w0 = tab.offsetWidth
    const h0 = tab.offsetHeight
    const fromLeft = 0
    const toLeft = w0 / 2 - FALL_WIDTH / 2
    let start: number | null = null

    const step = (now: number) => {
        if (start === null) start = now
        const elapsed = now - start
        const t = elapsed / 1000
        const tiltDone = t > 0.5
        const tilt = tiltDone
            ? TILT_DEG
            : TILT_DEG * (1 - (1 + TILT_OMEGA * t) * Math.exp(-TILT_OMEGA * t))
        body.style.transform = `rotate(${tilt}deg)`

        const fall = (elapsed - FALL_DELAY_MS) / FALL_DURATION_MS
        if (fall > 0) {
            const e = fallEase(Math.min(1, fall))
            body.style.right = "auto"
            body.style.bottom = "auto"
            body.style.left = `${fromLeft + (toLeft - fromLeft) * e}px`
            body.style.top = `${FALL_TOP * e}px`
            body.style.width = `${w0 + (FALL_WIDTH - w0) * e}px`
            body.style.height = `${h0 + (FALL_HEIGHT - h0) * e}px`
        }
        if (fall < 1 || !tiltDone) window.requestAnimationFrame(step)
    }
    window.requestAnimationFrame(step)
}

function buildTabs(flyer: HTMLElement) {
    const row = flyer.querySelector<HTMLElement>(".tabs")
    if (!row) return
    const count = Math.max(1, parseInt(row.dataset.count || "9", 10) || 9)
    const href = row.dataset.href || ""
    const label = row.dataset.label || ""
    row.textContent = ""
    for (let i = 0; i < count; i++) {
        const slot = document.createElement("div")
        slot.className = "tab-slot"
        const tab = document.createElement("a")
        tab.className = "tab"
        if (href) tab.href = href
        const body = document.createElement("div")
        body.className = "tab-body"
        const text = document.createElement("div")
        text.className = "tab-label"
        const p = document.createElement("p")
        p.dir = "auto"
        p.textContent = label
        text.appendChild(p)
        body.appendChild(text)
        tab.appendChild(body)
        slot.appendChild(tab)
        row.appendChild(slot)
        tab.addEventListener("click", () => tearOff(tab, body))
    }
}

// ---------------------------------------------------------------------------
// Bouncing logo: same logic as the BouncingLogo code component.
// ---------------------------------------------------------------------------

function startBouncingLogo(holder: HTMLElement): () => void {
    const src = holder.dataset.src || ""
    const logoWidth = Number(holder.dataset.width)
    const speedValue = Number(holder.dataset.speed)
    const link = holder.dataset.href || ""
    const newTab = holder.dataset.newTab !== "false"
    const f = Number.isFinite(logoWidth) ? Math.max(1, logoWidth) : 140
    const p = Number.isFinite(speedValue) ? Math.max(0, speedValue) : 110

    const box = document.createElement("div")
    Object.assign(box.style, {
        height: "100%",
        width: "100%",
        position: "relative",
        overflow: "hidden",
        background: "transparent",
    })
    const img = document.createElement("img")
    img.src = src
    img.alt = holder.dataset.alt || ""
    img.draggable = false
    img.sizes = `${f}px`
    Object.assign(img.style, {
        position: "absolute",
        display: "block",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: `${f}px`,
        height: "auto",
        maxWidth: "100%",
        maxHeight: "100%",
        objectFit: "contain",
        pointerEvents: link ? "auto" : "none",
        cursor: link ? "pointer" : "",
        userSelect: "none",
        willChange: "transform",
    })
    if (link) {
        const a = document.createElement("a")
        a.href = link
        a.setAttribute("aria-label", holder.dataset.label || "Click the star")
        if (newTab) {
            a.target = "_blank"
            a.rel = "noopener noreferrer"
        }
        a.style.display = "contents"
        a.appendChild(img)
        box.appendChild(a)
    } else {
        box.appendChild(img)
    }
    holder.appendChild(box)

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    let last: number | null = null
    let x = 0
    let y = 0
    let dirX = 1
    let dirY = 1
    let placed = false
    let stopped = false

    const fit = () => {
        const n = box.clientWidth
        const r = box.clientHeight
        const ratio =
            img.naturalWidth > 0 && img.naturalHeight > 0
                ? img.naturalWidth / img.naturalHeight
                : 309 / 338
        const a = Math.max(0, Math.min(f, n, r * ratio))
        const o = a / ratio
        img.style.width = `${a}px`
        img.style.height = `${o}px`
        return { maxX: Math.max(0, n - a), maxY: Math.max(0, r - o) }
    }
    const centre = () => {
        placed = false
        last = null
        img.style.left = "50%"
        img.style.top = "50%"
        img.style.transform = "translate(-50%, -50%)"
        fit()
    }
    const reflect = (pos: number, dir: number, delta: number, max: number) => {
        if (max <= 0) return { position: 0, direction: dir }
        const period = 2 * max
        const i =
            ((((dir > 0 ? pos : period - pos) + delta) % period) + period) %
            period
        return i < max
            ? { position: i, direction: 1 }
            : { position: period - i, direction: -1 }
    }
    const tick = (now: number) => {
        if (stopped || reduced.matches) return
        const { maxX, maxY } = fit()
        if (!placed) {
            x = maxX / 2
            y = maxY / 2
            placed = true
        }
        x = Math.min(maxX, Math.max(0, x))
        y = Math.min(maxY, Math.max(0, y))
        const dt = last === null ? 0 : Math.max(0, (now - last) / 1000)
        last = now
        const step = (p * dt) / Math.SQRT2
        const nx = reflect(x, dirX, step, maxX)
        const ny = reflect(y, dirY, step, maxY)
        x = nx.position
        y = ny.position
        dirX = nx.direction
        dirY = ny.direction
        img.style.left = "0px"
        img.style.top = "0px"
        img.style.transform = `translate3d(${x}px,${y}px,0)`
        frame = window.requestAnimationFrame(tick)
    }
    const restart = () => {
        window.cancelAnimationFrame(frame)
        centre()
        if (!reduced.matches && !stopped)
            frame = window.requestAnimationFrame(tick)
    }
    const onResize = () => {
        if (reduced.matches) centre()
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(box)
    img.addEventListener("load", restart)
    reduced.addEventListener("change", restart)
    restart()
    return () => {
        stopped = true
        window.cancelAnimationFrame(frame)
        observer.disconnect()
        img.removeEventListener("load", restart)
        reduced.removeEventListener("change", restart)
        box.remove()
    }
}

// ---------------------------------------------------------------------------
// The flyer and the back page are written in index.html (<template>), and
// placed inside the scene here.
// ---------------------------------------------------------------------------

function fromTemplate(id: string): HTMLElement | null {
    const tpl = document.getElementById(id) as HTMLTemplateElement | null
    const node = tpl && tpl.content.firstElementChild
    return node ? (node.cloneNode(true) as HTMLElement) : null
}

function Adopt(props: {
    node: HTMLElement
    setup?: (node: HTMLElement) => (() => void) | void
}) {
    const { node, setup } = props
    const ref = React.useRef<HTMLDivElement | null>(null)
    React.useLayoutEffect(() => {
        const host = ref.current
        if (!host) return
        host.appendChild(node)
        const cleanup = setup ? setup(node) : undefined
        return () => {
            if (cleanup) cleanup()
            node.remove()
        }
    }, [node, setup])
    return <div ref={ref} style={{ display: "contents" }} />
}

const setupFront = (node: HTMLElement) => {
    buildTabs(node)
}

const setupBack = (node: HTMLElement) => {
    const stops: Array<() => void> = []
    node.querySelectorAll<HTMLElement>("[data-bouncing-logo]").forEach((el) =>
        stops.push(startBouncingLogo(el))
    )
    return () => stops.forEach((stop) => stop())
}

function usePhone(maxWidth: number) {
    const query = `(max-width: ${maxWidth}px)`
    const [isPhone, setIsPhone] = React.useState(
        () => window.matchMedia(query).matches
    )
    React.useEffect(() => {
        const media = window.matchMedia(query)
        const update = () => setIsPhone(media.matches)
        update()
        media.addEventListener("change", update)
        return () => media.removeEventListener("change", update)
    }, [query])
    return isPhone
}

const frontNode = fromTemplate("front-flyer")
const backNode = fromTemplate("back-page")

function App() {
    const settings: SceneSettings = window.SCENE || {}
    const { phone, phoneMaxWidth, ...base } = settings
    const isPhone = usePhone(
        typeof phoneMaxWidth === "number" ? phoneMaxWidth : 809.98
    )
    const props = { ...base, ...(isPhone && phone ? phone : {}) }
    return (
        <LowPolyPoleScene
            {...(props as Record<string, never>)}
            style={{ width: "100%", height: "100%" }}
            frontFlyer={
                frontNode ? (
                    <Adopt node={frontNode} setup={setupFront} />
                ) : undefined
            }
            backContent={
                backNode ? (
                    <Adopt node={backNode} setup={setupBack} />
                ) : undefined
            }
        />
    )
}

const mount = document.getElementById("scene")
if (mount) createRoot(mount).render(<App />)
