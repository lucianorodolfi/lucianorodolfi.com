// Stand-ins for the few Framer helpers that LowPolyPoleScene imports.
// Outside Framer there is no property panel and no static (canvas) renderer.

export function addPropertyControls(_component: unknown, _controls: unknown) {}

export const ControlType: Record<string, string> = new Proxy(
    {},
    { get: (_target, key) => String(key) }
)

export function useIsStaticRenderer(): boolean {
    return false
}
