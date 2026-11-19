import * as React from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { motion } from "framer-motion"

interface MyComponentProps {
    frontFlyer?: React.ReactNode
    backContent?: React.ReactNode
    materialSource?: { src?: string; srcSet?: string; alt?: string }
    flyerWidth?: number
    flyerHeight?: number
    flyerTop?: number
    flyerMaxHeight?: number
    poleWidth?: number
    perspective?: number
    duration?: number
    initialSide?: "Front" | "Back"
    textureResolution?: number
    facetCount?: number
    backOffsetX?: number
    backOffsetY?: number
    backScale?: number
    backWidth?: number
    backHeight?: number
    reverseTilt?: number
    style?: React.CSSProperties
}

type TextureSet = {
    pole?: string
}

type GroundTextureData = {
    width: number
    height: number
    pixels: Uint8ClampedArray
}

type GroundTextureBundle = {
    grass?: GroundTextureData
    concrete?: GroundTextureData
    cobble?: GroundTextureData
}

const materialCache = new Map<
    string,
    { textures: TextureSet; ground: GroundTextureBundle }
>()
const MATERIAL_CACHE_LIMIT = 8
const FRONT_BLEED = 128
const DRAG_THRESHOLD = 40
const AXIS_SLOP = 10
const CLICK_SUPPRESS_MS = 500
const HINT_DELAY_MS = 600
const HINT_DURATION_MS = 1500
const HINT_ANGLE = 12

type DragGesture = {
    pointerId: number
    isMouse: boolean
    startX: number
    startY: number
    axis: "x" | "y" | null
    swiped: boolean
    fired: boolean
}

type ContentBox = { x: number; y: number; w: number; h: number }

// Layout effects run before the browser paints; on the server there is
// nothing to measure, so a normal effect is used there.
const useIsomorphicLayoutEffect =
    typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

// On touch screens the browser toolbars can cover part of the scene, so the
// flyer is centred in the area that is actually visible. On computers this
// returns the full height and nothing changes.
function measureVisibleHeight(
    root: HTMLElement,
    probe: HTMLElement | null,
    fullHeight: number
): number {
    if (typeof window === "undefined") return fullHeight
    const coarse =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches
    if (!coarse) return fullHeight
    const top = Math.max(0, root.getBoundingClientRect().top)
    let visible = fullHeight
    const probeHeight = probe ? probe.offsetHeight : 0
    if (probeHeight > 0) visible = Math.min(visible, probeHeight - top)
    if (window.innerHeight > 0)
        visible = Math.min(visible, window.innerHeight - top)
    return Math.max(1, Math.round(Math.min(fullHeight, visible)))
}

function smoothStep(t: number): number {
    const clamped = Math.max(0, Math.min(1, t))
    return clamped * clamped * (3 - 2 * clamped)
}

function easeInOutSine(t: number): number {
    const clamped = Math.max(0, Math.min(1, t))
    return 0.5 - 0.5 * Math.cos(Math.PI * clamped)
}

// Double hint: out to one side, across to the other side, back to rest.
// Returns a value between -1 and 1 for a progress between 0 and 1.
function hintAmount(progress: number): number {
    if (progress <= 0 || progress >= 1) return 0
    if (progress < 0.25) return easeInOutSine(progress / 0.25)
    if (progress < 0.75) return 1 - 2 * easeInOutSine((progress - 0.25) / 0.5)
    return -1 + easeInOutSine((progress - 0.75) / 0.25)
}

// Elements inside a slot that have a real layout box. Wrappers with
// display: contents have no box of their own, so their children are used.
function collectContentElements(slot: HTMLElement): HTMLElement[] {
    const found: HTMLElement[] = []
    const visit = (parent: Element) => {
        const children = Array.from(parent.children)
        for (const child of children) {
            if (!(child instanceof HTMLElement)) continue
            const display = window.getComputedStyle(child).display
            if (display === "none") continue
            if (display === "contents") {
                visit(child)
                continue
            }
            found.push(child)
        }
    }
    visit(slot)
    return found
}

// Box of the real content of a slot, in the slot's own (untransformed)
// pixels. Used to give the back content a white reverse of the right size.
function measureContentBox(slot: HTMLElement): ContentBox | null {
    if (typeof window === "undefined") return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const element of collectContentElements(slot)) {
        if (element.offsetParent !== slot) continue
        const w = element.offsetWidth
        const h = element.offsetHeight
        if (w <= 0 || h <= 0) continue
        let x = element.offsetLeft
        let y = element.offsetTop
        const transform = window.getComputedStyle(element).transform
        if (
            transform &&
            transform !== "none" &&
            typeof DOMMatrixReadOnly !== "undefined"
        ) {
            try {
                const m = new DOMMatrixReadOnly(transform)
                const isPlainTranslate =
                    m.is2D &&
                    Math.abs(m.a - 1) < 0.001 &&
                    Math.abs(m.d - 1) < 0.001 &&
                    Math.abs(m.b) < 0.001 &&
                    Math.abs(m.c) < 0.001
                if (isPlainTranslate) {
                    x += m.e
                    y += m.f
                }
            } catch (_err) {
                // Ignore transforms that cannot be parsed.
            }
        }
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x + w)
        maxY = Math.max(maxY, y + h)
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function cropToDataURL(
    image: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number,
    outputSize: number
): string {
    const canvas = document.createElement("canvas")
    canvas.width = outputSize
    canvas.height = outputSize
    const ctx = canvas.getContext("2d")
    if (!ctx) return ""
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, x, y, w, h, 0, 0, outputSize, outputSize)
    return canvas.toDataURL("image/jpeg", 0.8)
}

function cropToImageData(
    image: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number,
    outputSize: number
): GroundTextureData | undefined {
    const canvas = document.createElement("canvas")
    canvas.width = outputSize
    canvas.height = outputSize
    const ctx = canvas.getContext("2d")
    if (!ctx) return undefined
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, x, y, w, h, 0, 0, outputSize, outputSize)
    const data = ctx.getImageData(0, 0, outputSize, outputSize)
    return { width: outputSize, height: outputSize, pixels: data.data }
}

function mod(n: number, m: number): number {
    return ((n % m) + m) % m
}

function cubicBezierEase(t: number): number {
    const x1 = 0.25
    const y1 = 0.75
    const x2 = 0.3
    const y2 = 1
    let u = t
    for (let i = 0; i < 5; i++) {
        const omt = 1 - u
        const x = 3 * omt * omt * u * x1 + 3 * omt * u * u * x2 + u * u * u
        const dx =
            3 * omt * omt * x1 + 6 * omt * u * (x2 - x1) + 3 * u * u * (1 - x2)
        if (Math.abs(dx) < 1e-5) break
        u -= (x - t) / dx
        u = Math.max(0, Math.min(1, u))
    }
    const omt = 1 - u
    return 3 * omt * omt * u * y1 + 3 * omt * u * u * y2 + u * u * u
}

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight any-prefer-fixed
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 1045
 */
export default function LowPolyPoleScene(props: MyComponentProps) {
    const {
        frontFlyer,
        backContent,
        materialSource = {
            src: "https://framerusercontent.com/images/sKIp9bLan0kic4yw4lBzSLvt2Y.png",
            alt: "Pole source material",
        },
        flyerWidth = 600,
        flyerHeight = 846,
        flyerTop = 85,
        flyerMaxHeight = 85,
        poleWidth = 386,
        perspective = 1100,
        duration = 1.15,
        initialSide = "Front",
        textureResolution = 64,
        facetCount = 8,
        backOffsetX = 0,
        backOffsetY = 0,
        backScale = 1,
        backWidth = 600,
        backHeight = 846,
        reverseTilt = 2,
        style,
    } = props

    const isStatic = useIsStaticRenderer()
    const rootRef = React.useRef<HTMLDivElement | null>(null)
    const visibleProbeRef = React.useRef<HTMLDivElement | null>(null)
    const groundCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
    const yawRef = React.useRef<HTMLDivElement | null>(null)
    const frontInteractiveRef = React.useRef<HTMLDivElement | null>(null)
    const backInteractiveRef = React.useRef<HTMLDivElement | null>(null)
    const backContentRef = React.useRef<HTMLDivElement | null>(null)
    const rafRef = React.useRef<number | null>(null)
    const lockRef = React.useRef(false)
    const gestureRef = React.useRef<DragGesture | null>(null)
    const suppressClickUntilRef = React.useRef(0)
    const hintDoneRef = React.useRef(false)
    const angleRef = React.useRef(initialSide === "Front" ? 0 : 180)
    const groundRef = React.useRef<GroundTextureBundle>({})
    const groundBufferRef = React.useRef<{
        width: number
        height: number
        imageData: ImageData
    } | null>(null)
    const styleRef = React.useRef({
        viewportW: 1200,
        viewportH: 1045,
        perspective: 1100,
        tiltDeg: 30,
        camDist: 1000,
    })
    const layoutRef = React.useRef({
        flyerW: 600,
        flyerH: 846,
        paperW: 600,
        paperH: 846,
        paperTop: 85,
        scale: 1,
        targetCenterY: 0,
        d: 1000,
        py: 0,
        pz: 1000,
        tiltDeg: 30,
        backWidth: 600,
        backHeight: 846,
        backScale: 1,
        backOffsetX: 0,
        backOffsetY: 0,
    })
    const [viewport, setViewport] = React.useState({
        width: 1200,
        height: 1045,
        visibleHeight: 1045,
    })
    const [textures, setTextures] = React.useState<TextureSet>({})
    const [reducedMotion, setReducedMotion] = React.useState(false)
    const [isFront, setIsFront] = React.useState(initialSide === "Front")
    const [isAnimating, setIsAnimating] = React.useState(false)
    const [angle, setAngle] = React.useState(initialSide === "Front" ? 0 : 180)
    const [hasMeasured, setHasMeasured] = React.useState(false)
    const [materialReady, setMaterialReady] = React.useState(false)
    const [isGrabbing, setIsGrabbing] = React.useState(false)
    const [backBox, setBackBox] = React.useState<ContentBox | null>(null)

    React.useEffect(() => {
        if (
            typeof window === "undefined" ||
            typeof window.matchMedia !== "function"
        )
            return
        const media = window.matchMedia("(prefers-reduced-motion: reduce)")
        const update = () => setReducedMotion(media.matches)
        update()
        if (typeof media.addEventListener === "function") {
            media.addEventListener("change", update)
            return () => media.removeEventListener("change", update)
        }
        media.addListener(update)
        return () => media.removeListener(update)
    }, [])

    // Measure before the first paint, so the first visible frame already
    // uses the real size instead of the 1200 x 1045 default.
    useIsomorphicLayoutEffect(() => {
        const root = rootRef.current
        if (!root) return
        const width = Math.round(root.clientWidth)
        const height = Math.round(root.clientHeight)
        if (width <= 0 || height <= 0) return
        const visibleHeight = measureVisibleHeight(
            root,
            visibleProbeRef.current,
            height
        )
        setViewport((prev) =>
            prev.width === width &&
            prev.height === height &&
            prev.visibleHeight === visibleHeight
                ? prev
                : { width, height, visibleHeight }
        )
        setHasMeasured(true)
    }, [])

    React.useEffect(() => {
        if (
            typeof window === "undefined" ||
            typeof ResizeObserver === "undefined"
        )
            return
        const root = rootRef.current
        if (!root) return
        const update = () => {
            const width = Math.max(1, Math.round(root.clientWidth))
            const height = Math.max(1, Math.round(root.clientHeight))
            const visibleHeight = measureVisibleHeight(
                root,
                visibleProbeRef.current,
                height
            )
            setViewport((prev) =>
                prev.width === width &&
                prev.height === height &&
                prev.visibleHeight === visibleHeight
                    ? prev
                    : { width, height, visibleHeight }
            )
            if (root.clientWidth > 0 && root.clientHeight > 0)
                setHasMeasured(true)
        }
        const observer = new ResizeObserver(update)
        observer.observe(root)
        if (visibleProbeRef.current) observer.observe(visibleProbeRef.current)
        window.addEventListener("resize", update)
        return () => {
            observer.disconnect()
            window.removeEventListener("resize", update)
        }
    }, [])

    // Measure the real back content: its white reverse must match the page
    // itself, which can differ from the Back W / Back H box.
    React.useEffect(() => {
        if (typeof window === "undefined") return
        const slot = backContentRef.current
        if (!slot) return
        const measure = () => {
            const next = measureContentBox(slot)
            setBackBox((prev) => {
                if (!next) return prev === null ? prev : null
                if (
                    prev &&
                    Math.abs(prev.x - next.x) < 0.5 &&
                    Math.abs(prev.y - next.y) < 0.5 &&
                    Math.abs(prev.w - next.w) < 0.5 &&
                    Math.abs(prev.h - next.h) < 0.5
                )
                    return prev
                return next
            })
        }
        measure()
        let resizeObserver: ResizeObserver | null = null
        let mutationObserver: MutationObserver | null = null
        const observeContent = () => {
            if (!resizeObserver) return
            resizeObserver.disconnect()
            resizeObserver.observe(slot)
            for (const element of collectContentElements(slot))
                resizeObserver.observe(element)
        }
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => measure())
            observeContent()
        }
        if (typeof MutationObserver !== "undefined") {
            mutationObserver = new MutationObserver(() => {
                observeContent()
                measure()
            })
            mutationObserver.observe(slot, { childList: true, subtree: true })
        }
        return () => {
            if (resizeObserver) resizeObserver.disconnect()
            if (mutationObserver) mutationObserver.disconnect()
        }
    }, [backContent, backWidth, backHeight])

    React.useEffect(() => {
        if (typeof window === "undefined") return
        const src = materialSource?.src
        if (!src) {
            setMaterialReady(true)
            return
        }
        let cancelled = false
        const cacheKey = `${src}|${Math.max(16, Math.min(256, Math.round(textureResolution)))}`
        const cached = materialCache.get(cacheKey)
        if (cached) {
            setTextures(cached.textures)
            groundRef.current = cached.ground
            setMaterialReady(true)
            return
        }
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.decoding = "async"
        img.onload = () => {
            if (cancelled) return
            try {
                const iw = img.naturalWidth || 1
                const ih = img.naturalHeight || 1
                const res = Math.max(
                    16,
                    Math.min(256, Math.round(textureResolution))
                )
                const nextTextures: TextureSet = {
                    pole: cropToDataURL(
                        img,
                        iw * 0.38,
                        ih * 0.0,
                        iw * 0.24,
                        ih * 1.0,
                        res
                    ),
                }
                const nextGround: GroundTextureBundle = {
                    grass: cropToImageData(
                        img,
                        iw * 0.0,
                        ih * 0.0,
                        iw * 0.12,
                        ih * 0.3,
                        res
                    ),
                    concrete: cropToImageData(
                        img,
                        iw * 0.03,
                        ih * 0.65,
                        iw * 0.26,
                        ih * 0.33,
                        res
                    ),
                    cobble: cropToImageData(
                        img,
                        iw * 0.78,
                        ih * 0.25,
                        iw * 0.21,
                        ih * 0.73,
                        res
                    ),
                }
                materialCache.set(cacheKey, {
                    textures: nextTextures,
                    ground: nextGround,
                })
                if (materialCache.size > MATERIAL_CACHE_LIMIT) {
                    const firstKey = materialCache.keys().next().value
                    if (firstKey) materialCache.delete(firstKey)
                }
                setTextures(nextTextures)
                groundRef.current = nextGround
            } catch (_err) {
                setTextures({})
                groundRef.current = {}
            }
            setMaterialReady(true)
        }
        img.onerror = () => {
            if (!cancelled) {
                setTextures({})
                groundRef.current = {}
                setMaterialReady(true)
            }
        }
        img.src = src
        return () => {
            cancelled = true
        }
    }, [materialSource?.src, textureResolution])

    const syncInteractivity = React.useCallback(
        (animating: boolean, frontSide: boolean) => {
            const frontNode = frontInteractiveRef.current as
                | (HTMLDivElement & { inert?: boolean })
                | null
            const backNode = backInteractiveRef.current as
                | (HTMLDivElement & { inert?: boolean })
                | null
            const frontOff = animating || !frontSide
            const backOff = animating || frontSide
            if (frontNode) frontNode.inert = frontOff
            if (backNode) backNode.inert = backOff
        },
        []
    )

    React.useEffect(() => {
        syncInteractivity(isAnimating, isFront)
    }, [isAnimating, isFront, syncInteractivity])

    React.useEffect(() => {
        return () => {
            lockRef.current = false
            if (rafRef.current !== null && typeof window !== "undefined") {
                window.cancelAnimationFrame(rafRef.current)
            }
        }
    }, [])

    const maxFacet = Math.max(8, Math.min(10, Math.round(facetCount)))
    const durationSeconds =
        isStatic || reducedMotion ? 0 : Math.max(0.1, duration)
    const canInteract = !isAnimating

    const layout = React.useMemo(() => {
        const width = viewport.width || 1200
        const height = viewport.height || 1045
        // Part of the scene not covered by browser toolbars (phones only).
        const visibleHeight = Math.max(
            1,
            Math.min(height, viewport.visibleHeight || height)
        )
        const horizontalMargin = width < 700 ? 24 : 96
        const verticalMargin = width < 700 ? 20 : 24
        const safeW = Math.max(1, flyerWidth)
        const safeH = Math.max(1, flyerHeight)
        // The flyer never takes more than this share of the scene height,
        // so part of the pole stays visible above and below it.
        const maxHeightShare = Math.max(
            0.3,
            Math.min(
                1,
                (Number.isFinite(flyerMaxHeight) ? flyerMaxHeight : 85) / 100
            )
        )
        const availableHeight = Math.min(
            visibleHeight - verticalMargin * 2,
            visibleHeight * maxHeightShare
        )
        const scale = Math.max(
            0.001,
            Math.min(
                1,
                (width - horizontalMargin * 2) / safeW,
                availableHeight / safeH
            )
        )
        const paperW = safeW * scale
        const paperH = safeH * scale
        // Full size: the flyer sits at Flyer Top. Scaled down to 85% or
        // less: it is centred vertically. In between the two are blended,
        // so the flyer never jumps while the container is resized.
        const centredTop = Math.max(
            verticalMargin,
            (visibleHeight - paperH) / 2
        )
        const topBlend = smoothStep((scale - 0.85) / 0.15)
        return {
            width,
            height,
            scale,
            paperW,
            paperH,
            paperTop: centredTop + (flyerTop - centredTop) * topBlend,
            targetPoleWidth: poleWidth * Math.max(0.75, scale),
        }
    }, [viewport, flyerWidth, flyerHeight, flyerTop, flyerMaxHeight, poleWidth])

    const requestedPerspective = Number.isFinite(perspective)
        ? perspective
        : 1100
    const safePerspective = Math.max(
        requestedPerspective,
        layout.height * 0.65,
        layout.targetPoleWidth * 1.5,
        200
    )
    const tiltDeg = Math.max(
        30,
        (Math.atan(layout.height / (2 * safePerspective)) * 180) / Math.PI + 4
    )
    const t = (tiltDeg * Math.PI) / 180
    const c = Math.cos(t)
    const s = Math.sin(t)
    const targetCenterY =
        layout.paperTop + layout.paperH / 2 - layout.height / 2
    const R = layout.targetPoleWidth / 2
    const q =
        (layout.paperH / 2 + FRONT_BLEED * layout.scale - targetCenterY) * s +
        12
    const K = q / c
    const denomRaw = safePerspective - R * (1 / c - c)
    const denom = Math.max(0.001, denomRaw)
    const A = (R * (safePerspective + K)) / denom
    const d = (A + q) / c
    const py = targetCenterY * c - d * s
    const pz = targetCenterY * s + d * c
    const facetAngle = 360 / maxFacet
    const faceWidth = Math.max(1, 2 * A * Math.tan(Math.PI / maxFacet))
    // Until the real size is known the layers stay invisible (the grey
    // background remains), so nothing is ever shown at the wrong size.
    const sceneOpacity = !hasMeasured && !isStatic ? 0 : undefined
    const hasFrontContent = React.Children.count(frontFlyer) > 0
    const hasBackContent = React.Children.count(backContent) > 0

    // White reverse of the back content, in the plane of the back sheet.
    const totalScaleBackNow = layout.scale * backScale
    const backReverseBox = backBox || {
        x: 0,
        y: 0,
        w: backWidth,
        h: backHeight,
    }
    const backReverseLeft =
        -(backWidth * totalScaleBackNow) / 2 +
        backOffsetX * layout.scale +
        backReverseBox.x * totalScaleBackNow
    const backReverseTop =
        -(backHeight * totalScaleBackNow) / 2 +
        backOffsetY * layout.scale +
        backReverseBox.y * totalScaleBackNow
    const backReverseW = backReverseBox.w * totalScaleBackNow
    const backReverseH = backReverseBox.h * totalScaleBackNow

    const updateFacePaint = React.useCallback((angleDeg: number) => {
        const phi = (angleDeg * Math.PI) / 180
        const localTilt = (styleRef.current.tiltDeg * Math.PI) / 180
        const cTilt = Math.cos(localTilt)
        const sTilt = Math.sin(localTilt)
        const p = styleRef.current.perspective
        const dCam = styleRef.current.camDist
        const frontFacing =
            (p + dCam) * (sTilt * sTilt + cTilt * cTilt * Math.cos(phi)) -
                dCam >
            0
        const backFacing =
            (p + dCam) * (sTilt * sTilt - cTilt * cTilt * Math.cos(phi)) -
                dCam >
            0
        if (frontInteractiveRef.current) {
            frontInteractiveRef.current.style.visibility = frontFacing
                ? "visible"
                : "hidden"
        }
        if (backInteractiveRef.current) {
            backInteractiveRef.current.style.visibility = backFacing
                ? "visible"
                : "hidden"
        }
    }, [])

    const buildLiveTransforms = React.useCallback((angleDeg: number) => {
        // The slots are only positioned here. Their content is scaled by a
        // motion wrapper inside each slot (around its own centre), because
        // Framer's layout animations only compensate for scales applied
        // through motion components. With a plain CSS scale, animations
        // inside the flyer (such as the tear-off tabs) start with a jump.
        const p = layoutRef.current
        const normalized = ((angleDeg % 360) + 360) % 360
        const nearFront = Math.min(normalized, 360 - normalized) < 0.001
        const nearBack = Math.abs(normalized - 180) < 0.001
        const frontContinuous = `translateZ(${-p.d}px) rotateX(-${p.tiltDeg}deg) rotateY(${angleDeg}deg) translateY(${p.py}px) translateZ(${p.pz}px) rotateX(${p.tiltDeg}deg) translate(${-p.flyerW / 2}px, ${-p.flyerH / 2}px)`
        const frontRest2D = `translate(${-p.flyerW / 2}px, ${p.targetCenterY - p.flyerH / 2}px)`
        const backContinuous = `translateZ(${-p.d}px) rotateX(-${p.tiltDeg}deg) rotateY(${angleDeg}deg) translateY(${p.py}px) translateZ(${-p.pz}px) rotateY(180deg) rotateX(${p.tiltDeg}deg) translate(${-p.backWidth / 2 + p.backOffsetX * p.scale}px, ${-p.backHeight / 2 + p.backOffsetY * p.scale}px)`
        const backRest2D = `translate(${-p.backWidth / 2 + p.backOffsetX * p.scale}px, ${p.targetCenterY + p.backOffsetY * p.scale - p.backHeight / 2}px)`
        return {
            front: nearFront ? frontRest2D : frontContinuous,
            back: nearBack ? backRest2D : backContinuous,
        }
    }, [])

    const updateLiveTransforms = React.useCallback(
        (angleDeg: number) => {
            const transforms = buildLiveTransforms(angleDeg)
            if (frontInteractiveRef.current) {
                frontInteractiveRef.current.style.transform = transforms.front
            }
            if (backInteractiveRef.current) {
                backInteractiveRef.current.style.transform = transforms.back
            }
        },
        [buildLiveTransforms]
    )

    const paintGround = React.useCallback((angleDeg: number) => {
        if (typeof window === "undefined") return
        const canvas = groundCanvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext("2d")
        if (!ctx) return

        const vw = styleRef.current.viewportW
        const vh = styleRef.current.viewportH
        const outW = Math.max(64, Math.min(320, Math.ceil(vw / 4)))
        const outH = Math.max(64, Math.min(320, Math.ceil(vh / 4)))
        if (
            canvas.width !== outW ||
            canvas.height !== outH ||
            !groundBufferRef.current
        ) {
            canvas.width = outW
            canvas.height = outH
            groundBufferRef.current = {
                width: outW,
                height: outH,
                imageData: ctx.createImageData(outW, outH),
            }
        }
        const img = groundBufferRef.current.imageData
        const dst = img.data

        const floorY = 1600
        const p = styleRef.current.perspective
        const tilt = (styleRef.current.tiltDeg * Math.PI) / 180
        const cTilt = Math.cos(tilt)
        const sTilt = Math.sin(tilt)
        const dCam = styleRef.current.camDist
        const o0y = -(p + dCam) * sTilt
        const o0z = (p + dCam) * cTilt
        const yaw = (angleDeg * Math.PI) / 180
        const cy = Math.cos(yaw)
        const sy = Math.sin(yaw)
        const texturesData = groundRef.current
        const ox = -o0z * sy
        const oy = o0y
        const oz = o0z * cy
        const fallbackA = [102, 120, 95]
        const fallbackB = [118, 122, 124]
        const fallbackC = [102, 106, 111]

        for (let y = 0; y < outH; y++) {
            const dy = ((y + 0.5) / outH) * vh - vh / 2
            const dir0y = dy * cTilt + p * sTilt
            const dir0zBase = dy * sTilt - p * cTilt
            for (let x = 0; x < outW; x++) {
                const dx = ((x + 0.5) / outW) * vw - vw / 2
                const dir0x = dx
                const rx = dir0x * cy - dir0zBase * sy
                const ry = dir0y
                const rz = dir0x * sy + dir0zBase * cy

                const idx = (y * outW + x) * 4
                if (Math.abs(ry) < 1e-6) {
                    dst[idx] = 114
                    dst[idx + 1] = 118
                    dst[idx + 2] = 118
                    dst[idx + 3] = 255
                    continue
                }
                const tRay = (floorY - oy) / ry
                if (tRay <= 0) {
                    dst[idx] = 110
                    dst[idx + 1] = 114
                    dst[idx + 2] = 114
                    dst[idx + 3] = 255
                    continue
                }

                const hitX = ox + rx * tRay
                const hitZ = oz + rz * tRay
                const cellX = Math.floor(hitX / 2400)
                const cellZ = Math.floor(hitZ / 2400)
                const brightness =
                    0.85 + ((((cellX * 17 + cellZ * 13) % 5) + 5) % 5) * 0.05

                const mat =
                    hitX < -650
                        ? texturesData.grass
                        : hitX <= 250
                          ? texturesData.concrete
                          : texturesData.cobble

                if (mat) {
                    const u = Math.floor((mod(hitX, 600) / 600) * mat.width)
                    const v = Math.floor((mod(hitZ, 600) / 600) * mat.height)
                    const mi = (v * mat.width + u) * 4
                    dst[idx] = Math.min(255, mat.pixels[mi] * brightness)
                    dst[idx + 1] = Math.min(
                        255,
                        mat.pixels[mi + 1] * brightness
                    )
                    dst[idx + 2] = Math.min(
                        255,
                        mat.pixels[mi + 2] * brightness
                    )
                    dst[idx + 3] = 255
                } else {
                    const base =
                        hitX < -650
                            ? fallbackA
                            : hitX <= 250
                              ? fallbackB
                              : fallbackC
                    dst[idx] = Math.min(255, base[0] * brightness)
                    dst[idx + 1] = Math.min(255, base[1] * brightness)
                    dst[idx + 2] = Math.min(255, base[2] * brightness)
                    dst[idx + 3] = 255
                }
            }
        }
        ctx.putImageData(img, 0, 0)
    }, [])

    useIsomorphicLayoutEffect(() => {
        styleRef.current = {
            viewportW: layout.width,
            viewportH: layout.height,
            perspective: safePerspective,
            tiltDeg,
            camDist: d,
        }
        layoutRef.current = {
            flyerW: Math.max(1, flyerWidth),
            flyerH: Math.max(1, flyerHeight),
            paperW: layout.paperW,
            paperH: layout.paperH,
            paperTop: layout.paperTop,
            scale: layout.scale,
            targetCenterY,
            d,
            py,
            pz,
            tiltDeg,
            backWidth,
            backHeight,
            backScale,
            backOffsetX,
            backOffsetY,
        }
        paintGround(angleRef.current)
        updateFacePaint(angleRef.current)
        updateLiveTransforms(angleRef.current)
    }, [
        layout.width,
        layout.height,
        safePerspective,
        tiltDeg,
        d,
        paintGround,
        updateFacePaint,
        updateLiveTransforms,
        textures,
        angle,
        flyerWidth,
        flyerHeight,
        layout.paperW,
        layout.paperH,
        layout.paperTop,
        layout.scale,
        targetCenterY,
        backWidth,
        backHeight,
        backScale,
        backOffsetX,
        backOffsetY,
        py,
        pz,
    ])

    React.useEffect(() => {
        lockRef.current = false
        if (rafRef.current !== null && typeof window !== "undefined") {
            window.cancelAnimationFrame(rafRef.current)
            rafRef.current = null
        }
        const next = initialSide === "Front" ? 0 : 180
        angleRef.current = next
        if (yawRef.current)
            yawRef.current.style.transform = `rotateY(${next}deg)`
        paintGround(next)
        updateFacePaint(next)
        updateLiveTransforms(next)
        setIsFront(initialSide === "Front")
        setAngle(next)
        setIsAnimating(false)
        syncInteractivity(false, initialSide === "Front")
    }, [
        initialSide,
        paintGround,
        syncInteractivity,
        updateFacePaint,
        updateLiveTransforms,
    ])

    const toggle = React.useCallback(
        (direction: 1 | -1) => {
            if (!canInteract || lockRef.current) return
            lockRef.current = true
            const start = angleRef.current
            const end = start + 180 * direction
            const frontAfter = !isFront
            setIsAnimating(true)
            setIsFront(frontAfter)
            syncInteractivity(true, frontAfter)
            setAngle(end)
            if (durationSeconds <= 0) {
                angleRef.current = end
                if (yawRef.current)
                    yawRef.current.style.transform = `rotateY(${end}deg)`
                paintGround(end)
                updateFacePaint(end)
                updateLiveTransforms(end)
                lockRef.current = false
                setIsAnimating(false)
                syncInteractivity(false, frontAfter)
                return
            }
            if (
                typeof window === "undefined" ||
                typeof window.requestAnimationFrame !== "function"
            ) {
                angleRef.current = end
                if (yawRef.current)
                    yawRef.current.style.transform = `rotateY(${end}deg)`
                paintGround(end)
                updateFacePaint(end)
                updateLiveTransforms(end)
                lockRef.current = false
                setIsAnimating(false)
                syncInteractivity(false, frontAfter)
                return
            }
            if (rafRef.current !== null)
                window.cancelAnimationFrame(rafRef.current)
            const startTime = window.performance.now()
            let lastPaint = 0
            const step = (now: number) => {
                const elapsed = now - startTime
                const progress = Math.max(
                    0,
                    Math.min(1, elapsed / (durationSeconds * 1000))
                )
                const eased = cubicBezierEase(progress)
                const next = start + (end - start) * eased
                angleRef.current = next
                if (yawRef.current)
                    yawRef.current.style.transform = `rotateY(${next}deg)`
                updateLiveTransforms(next)
                if (now - lastPaint > 16 || progress >= 1) {
                    paintGround(next)
                    updateFacePaint(next)
                    lastPaint = now
                }
                if (progress < 1) {
                    rafRef.current = window.requestAnimationFrame(step)
                } else {
                    lockRef.current = false
                    rafRef.current = null
                    setIsAnimating(false)
                    syncInteractivity(false, frontAfter)
                }
            }
            rafRef.current = window.requestAnimationFrame(step)
        },
        [
            canInteract,
            durationSeconds,
            isFront,
            paintGround,
            syncInteractivity,
            updateFacePaint,
            updateLiveTransforms,
        ]
    )

    const toggleRef = React.useRef(toggle)
    toggleRef.current = toggle

    // One-time hint on load: nudge the scene a few degrees to one side,
    // then to the other, and settle back.
    React.useEffect(() => {
        if (isStatic || reducedMotion) return
        if (!hasMeasured || !materialReady) return
        if (hintDoneRef.current) return
        if (
            typeof window === "undefined" ||
            typeof window.requestAnimationFrame !== "function"
        )
            return
        const timer = window.setTimeout(() => {
            if (hintDoneRef.current) return
            hintDoneRef.current = true
            if (lockRef.current) return
            if (
                typeof window.matchMedia === "function" &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches
            )
                return
            lockRef.current = true
            const base = angleRef.current
            const startTime = window.performance.now()
            let lastPaint = 0
            const step = (now: number) => {
                const progress = Math.max(
                    0,
                    Math.min(1, (now - startTime) / HINT_DURATION_MS)
                )
                const amount = hintAmount(progress)
                const next = progress >= 1 ? base : base + HINT_ANGLE * amount
                angleRef.current = next
                if (yawRef.current)
                    yawRef.current.style.transform = `rotateY(${next}deg)`
                updateLiveTransforms(next)
                if (now - lastPaint > 16 || progress >= 1) {
                    paintGround(next)
                    updateFacePaint(next)
                    lastPaint = now
                }
                if (progress < 1) {
                    rafRef.current = window.requestAnimationFrame(step)
                } else {
                    lockRef.current = false
                    rafRef.current = null
                }
            }
            if (rafRef.current !== null)
                window.cancelAnimationFrame(rafRef.current)
            rafRef.current = window.requestAnimationFrame(step)
        }, HINT_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [
        isStatic,
        reducedMotion,
        hasMeasured,
        materialReady,
        paintGround,
        updateFacePaint,
        updateLiveTransforms,
    ])

    // Touch screens only (phones and tablets): lock the whole page so it
    // can never scroll. The scene is a single screen, but mobile Safari and
    // Chrome make "100% of the window" slightly taller than the visible area
    // because of their toolbars, which let the page shift up and down.
    // Computers (mouse or trackpad) are not affected.
    React.useEffect(() => {
        if (isStatic || typeof document === "undefined") return
        const tag = document.createElement("style")
        tag.setAttribute("data-pole-scene-scroll-lock", "")
        tag.textContent =
            "@media (pointer: coarse) { html, body { overflow: hidden; overscroll-behavior: none; } }"
        document.head.appendChild(tag)
        return () => {
            tag.remove()
        }
    }, [isStatic])

    // Mouse drag (outside the content slots) and touch swipe (anywhere).
    // Both only trigger the existing 180 degree rotation once per gesture.
    React.useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const root = rootRef.current
        if (!root) return

        const isInsideSlot = (target: EventTarget | null) => {
            if (!(target instanceof Node)) return false
            const front = frontInteractiveRef.current
            const back = backInteractiveRef.current
            return Boolean(
                (front && front.contains(target)) ||
                    (back && back.contains(target))
            )
        }

        const endGesture = (event: PointerEvent, cancelled: boolean) => {
            const gesture = gestureRef.current
            if (!gesture || gesture.pointerId !== event.pointerId) return
            gestureRef.current = null
            if (gesture.swiped && !cancelled) {
                suppressClickUntilRef.current = Date.now() + CLICK_SUPPRESS_MS
            }
            if (gesture.isMouse) {
                setIsGrabbing(false)
                try {
                    if (root.hasPointerCapture(gesture.pointerId))
                        root.releasePointerCapture(gesture.pointerId)
                } catch (_err) {
                    // Pointer capture is optional.
                }
            }
        }

        const onPointerDown = (event: PointerEvent) => {
            if (!event.isPrimary) return
            suppressClickUntilRef.current = 0
            const isMouse = event.pointerType === "mouse"
            if (isMouse && (event.button !== 0 || isInsideSlot(event.target))) {
                gestureRef.current = null
                setIsGrabbing(false)
                return
            }
            gestureRef.current = {
                pointerId: event.pointerId,
                isMouse,
                startX: event.clientX,
                startY: event.clientY,
                axis: null,
                swiped: false,
                fired: false,
            }
            if (isMouse) {
                setIsGrabbing(true)
                try {
                    root.setPointerCapture(event.pointerId)
                } catch (_err) {
                    // Pointer capture is optional.
                }
            }
        }

        const onPointerMove = (event: PointerEvent) => {
            const gesture = gestureRef.current
            if (!gesture || gesture.pointerId !== event.pointerId) return
            if (gesture.isMouse && event.buttons === 0) {
                endGesture(event, true)
                return
            }
            if (gesture.fired) return
            const dx = event.clientX - gesture.startX
            const dy = event.clientY - gesture.startY
            const ax = Math.abs(dx)
            const ay = Math.abs(dy)
            if (!gesture.isMouse) {
                if (gesture.axis === null) {
                    if (ax < AXIS_SLOP && ay < AXIS_SLOP) return
                    gesture.axis = ax > ay ? "x" : "y"
                }
                // Vertical movement is ignored: the scene fills the screen
                // and the page must not move.
                if (gesture.axis === "y") return
                if (ax <= ay * 1.5) return
            }
            if (ax <= DRAG_THRESHOLD) return
            gesture.swiped = true
            if (lockRef.current) {
                // A rotation or the hint is running: ignore this gesture.
                gesture.fired = true
                return
            }
            const before = angleRef.current
            toggleRef.current(dx > 0 ? 1 : -1)
            if (lockRef.current || angleRef.current !== before) {
                gesture.fired = true
                hintDoneRef.current = true
            }
        }

        const onPointerUp = (event: PointerEvent) => endGesture(event, false)
        const onPointerCancel = (event: PointerEvent) => endGesture(event, true)

        const onClickCapture = (event: MouseEvent) => {
            if (Date.now() >= suppressClickUntilRef.current) return
            suppressClickUntilRef.current = 0
            event.preventDefault()
            event.stopPropagation()
        }

        const onSelectStart = (event: Event) => {
            if (gestureRef.current && gestureRef.current.isMouse)
                event.preventDefault()
        }

        root.addEventListener("pointerdown", onPointerDown)
        root.addEventListener("click", onClickCapture, true)
        window.addEventListener("pointermove", onPointerMove)
        window.addEventListener("pointerup", onPointerUp)
        window.addEventListener("pointercancel", onPointerCancel)
        document.addEventListener("selectstart", onSelectStart)
        return () => {
            root.removeEventListener("pointerdown", onPointerDown)
            root.removeEventListener("click", onClickCapture, true)
            window.removeEventListener("pointermove", onPointerMove)
            window.removeEventListener("pointerup", onPointerUp)
            window.removeEventListener("pointercancel", onPointerCancel)
            document.removeEventListener("selectstart", onSelectStart)
            gestureRef.current = null
        }
    }, [isStatic])

    return (
        <div
            ref={rootRef}
            style={{
                ...style,
                position: "relative",
                width: "100%",
                height: "100%",
                background: "#7f8280",
                perspective: safePerspective,
                perspectiveOrigin: "50% 50%",
                // No browser panning or bounce from touches on the scene.
                // On phones the page is a single screen, and letting the
                // browser handle vertical drags made the whole page shift
                // up and down (Safari makes 100vh taller than the visible
                // area). Taps, links and the horizontal swipe still work.
                touchAction: "none",
                cursor: isStatic ? undefined : isGrabbing ? "grabbing" : "grab",
                ...(isGrabbing
                    ? ({
                          userSelect: "none",
                          WebkitUserSelect: "none",
                      } as const)
                    : null),
            }}
        >
            {/* Invisible ruler, as tall as the visible screen (100svh).
                It sits in a zero-size clipped box so it never adds
                scrollable space to the page. */}
            <div
                aria-hidden="true"
                style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 0,
                    height: 0,
                    overflow: "hidden",
                    visibility: "hidden",
                    pointerEvents: "none",
                }}
            >
                <div
                    ref={visibleProbeRef}
                    style={{ width: 1, height: "100svh" }}
                />
            </div>
            <canvas
                ref={groundCanvasRef}
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                    imageRendering: "pixelated",
                    zIndex: 0,
                    opacity: sceneOpacity,
                }}
            />
            <div
                style={{
                    position: "absolute",
                    left: layout.width / 2,
                    top: layout.height / 2,
                    width: 0,
                    height: 0,
                    transformStyle: "preserve-3d",
                    pointerEvents: "none",
                    zIndex: 1,
                    opacity: sceneOpacity,
                }}
            >
                <div
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        transformStyle: "preserve-3d",
                        transform: `translateZ(${-d}px) rotateX(-${tiltDeg}deg)`,
                    }}
                >
                    <div
                        ref={yawRef}
                        style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            transformStyle: "preserve-3d",
                            transform: `rotateY(${angleRef.current}deg)`,
                        }}
                    >
                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                top: -2500,
                                width: 0,
                                height: 4100,
                                transformStyle: "preserve-3d",
                            }}
                        >
                            {Array.from({ length: maxFacet }).map((_, i) => {
                                const r = Math.round(112 + (i % 4) * 10)
                                return (
                                    <div
                                        key={`pole-facet-${i}`}
                                        style={{
                                            position: "absolute",
                                            left: -(faceWidth + 0.25) / 2,
                                            top: 0,
                                            width: faceWidth + 0.25,
                                            height: "100%",
                                            transformOrigin: "50% 50%",
                                            transformStyle: "preserve-3d",
                                            transform: `rotateY(${i * facetAngle}deg) translateZ(${A}px)`,
                                            backgroundImage: textures.pole
                                                ? `url(${textures.pole})`
                                                : undefined,
                                            backgroundColor: textures.pole
                                                ? undefined
                                                : `rgb(${r}, ${r + 2}, ${r + 3})`,
                                            backgroundSize: `${maxFacet * 100}% 100%`,
                                            backgroundPosition: `${(i / (maxFacet - 1)) * 100}% 50%`,
                                            imageRendering: "pixelated",
                                            backfaceVisibility: "hidden",
                                        }}
                                    />
                                )
                            })}
                        </div>

                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                top: py,
                                width: 0,
                                height: 0,
                                transformStyle: "preserve-3d",
                                transform: `translateZ(${pz}px) rotateX(${tiltDeg}deg)`,
                                pointerEvents: "none",
                            }}
                        >
                            {frontFlyer ? (
                                <div
                                    style={{
                                        position: "absolute",
                                        left: -layout.paperW / 2,
                                        top: -layout.paperH / 2,
                                        width: layout.paperW,
                                        height: layout.paperH,
                                        transformOrigin: "center center",
                                        transformStyle: "preserve-3d",
                                        transform: `rotateZ(${reverseTilt}deg) rotateY(180deg)`,
                                        background: "#ffffff",
                                        backfaceVisibility: "hidden",
                                        pointerEvents: "none",
                                    }}
                                />
                            ) : null}
                        </div>

                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                top: py,
                                width: 0,
                                height: 0,
                                transformStyle: "preserve-3d",
                                transform: `translateZ(${-pz}px) rotateY(180deg) rotateX(${tiltDeg}deg)`,
                                pointerEvents: "none",
                            }}
                        >
                            {hasBackContent ? (
                                <div
                                    style={{
                                        position: "absolute",
                                        left: backReverseLeft,
                                        top: backReverseTop,
                                        width: backReverseW,
                                        height: backReverseH,
                                        transformOrigin: "center center",
                                        transformStyle: "preserve-3d",
                                        transform: `rotateZ(${reverseTilt}deg) rotateY(180deg)`,
                                        background: "#ffffff",
                                        backfaceVisibility: "hidden",
                                        pointerEvents: "none",
                                    }}
                                />
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>

            <div
                key="front-slot-stable"
                ref={frontInteractiveRef}
                aria-hidden={isAnimating || !isFront}
                style={{
                    position: "absolute",
                    left: layout.width / 2,
                    top: layout.height / 2,
                    width: flyerWidth,
                    height: flyerHeight,
                    overflow: "visible",
                    transformOrigin: "0 0",
                    transformStyle: "preserve-3d",
                    backfaceVisibility: "visible",
                    pointerEvents: "none",
                    zIndex: 2,
                    opacity: sceneOpacity,
                    visibility:
                        (safePerspective + d) *
                            (s * s +
                                c *
                                    c *
                                    Math.cos(
                                        (angleRef.current * Math.PI) / 180
                                    )) -
                            d >
                        0
                            ? "visible"
                            : "hidden",
                    transform: buildLiveTransforms(angleRef.current).front,
                }}
            >
                <motion.div
                    style={{
                        position: "relative",
                        width: flyerWidth,
                        height: flyerHeight,
                        scale: layout.scale,
                        pointerEvents:
                            isAnimating || !isFront || !hasFrontContent
                                ? "none"
                                : "auto",
                        cursor: isGrabbing ? "grabbing" : "auto",
                    }}
                >
                    {frontFlyer}
                </motion.div>
            </div>

            <div
                key="back-slot-stable"
                ref={backInteractiveRef}
                aria-hidden={isAnimating || isFront}
                style={{
                    position: "absolute",
                    left: layout.width / 2,
                    top: layout.height / 2,
                    width: backWidth,
                    height: backHeight,
                    overflow: "visible",
                    transformOrigin: "0 0",
                    transformStyle: "preserve-3d",
                    backfaceVisibility: "visible",
                    pointerEvents: "none",
                    zIndex: 2,
                    opacity: sceneOpacity,
                    visibility:
                        (safePerspective + d) *
                            (s * s -
                                c *
                                    c *
                                    Math.cos(
                                        (angleRef.current * Math.PI) / 180
                                    )) -
                            d >
                        0
                            ? "visible"
                            : "hidden",
                    transform: buildLiveTransforms(angleRef.current).back,
                }}
            >
                <motion.div
                    ref={backContentRef}
                    style={{
                        position: "relative",
                        width: backWidth,
                        height: backHeight,
                        scale: layout.scale * backScale,
                        pointerEvents:
                            isAnimating || isFront || !hasBackContent
                                ? "none"
                                : "auto",
                        cursor: isGrabbing ? "grabbing" : "auto",
                    }}
                >
                    {backContent}
                </motion.div>
            </div>
        </div>
    )
}

addPropertyControls(LowPolyPoleScene, {
    frontFlyer: {
        type: ControlType.ComponentInstance,
        title: "Front flyer",
    },
    backContent: {
        type: ControlType.ComponentInstance,
        title: "Back content",
    },
    materialSource: {
        type: ControlType.ResponsiveImage,
        title: "Material Source",
    },
    flyerWidth: {
        type: ControlType.Number,
        title: "Flyer W",
        defaultValue: 600,
        min: 200,
        max: 1000,
        step: 1,
        unit: "px",
    },
    flyerHeight: {
        type: ControlType.Number,
        title: "Flyer H",
        defaultValue: 846,
        min: 260,
        max: 1400,
        step: 1,
        unit: "px",
    },
    flyerTop: {
        type: ControlType.Number,
        title: "Flyer Top",
        defaultValue: 85,
        min: 0,
        max: 400,
        step: 1,
        unit: "px",
    },
    flyerMaxHeight: {
        type: ControlType.Number,
        title: "Flyer Max H",
        defaultValue: 85,
        min: 40,
        max: 100,
        step: 1,
        unit: "%",
    },
    poleWidth: {
        type: ControlType.Number,
        title: "Pole Width",
        defaultValue: 386,
        min: 120,
        max: 700,
        step: 1,
        unit: "px",
    },
    perspective: {
        type: ControlType.Number,
        title: "Perspective",
        defaultValue: 1100,
        min: 400,
        max: 2200,
        step: 10,
        unit: "px",
    },
    duration: {
        type: ControlType.Number,
        title: "Duration",
        defaultValue: 1.15,
        min: 0.1,
        max: 3,
        step: 0.01,
        unit: "s",
    },
    initialSide: {
        type: ControlType.Enum,
        title: "Initial Side",
        defaultValue: "Front",
        options: ["Front", "Back"],
        optionTitles: ["Front", "Back"],
    },
    textureResolution: {
        type: ControlType.Number,
        title: "Tex Res",
        defaultValue: 64,
        min: 16,
        max: 256,
        step: 1,
    },
    facetCount: {
        type: ControlType.Number,
        title: "Facets",
        defaultValue: 8,
        min: 8,
        max: 10,
        step: 1,
    },
    backOffsetX: {
        type: ControlType.Number,
        title: "Back X",
        defaultValue: 0,
        min: -400,
        max: 400,
        step: 1,
        unit: "px",
    },
    backOffsetY: {
        type: ControlType.Number,
        title: "Back Y",
        defaultValue: 0,
        min: -400,
        max: 400,
        step: 1,
        unit: "px",
    },
    backScale: {
        type: ControlType.Number,
        title: "Back Scale",
        defaultValue: 1,
        min: 0.2,
        max: 2,
        step: 0.01,
    },
    backWidth: {
        type: ControlType.Number,
        title: "Back W",
        defaultValue: 600,
        min: 100,
        max: 1200,
        step: 1,
        unit: "px",
    },
    backHeight: {
        type: ControlType.Number,
        title: "Back H",
        defaultValue: 846,
        min: 100,
        max: 1600,
        step: 1,
        unit: "px",
    },
    reverseTilt: {
        type: ControlType.Number,
        title: "Reverse Tilt",
        defaultValue: 2,
        min: -20,
        max: 20,
        step: 0.1,
        unit: "deg",
    },
})
