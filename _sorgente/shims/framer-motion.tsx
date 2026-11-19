import * as React from "react"

// LowPolyPoleScene only uses motion.div to scale the flyer (style.scale).
// Here a plain div applies the same CSS scale, around its centre, exactly
// as Framer Motion renders it ("none" at scale 1).
type DivProps = React.HTMLAttributes<HTMLDivElement> & {
    style?: React.CSSProperties & { scale?: number }
}

const MotionDiv = React.forwardRef<HTMLDivElement, DivProps>(
    function MotionDiv({ style, ...rest }, ref) {
        const { scale, ...css } = style || {}
        const transform =
            typeof scale === "number" && scale !== 1
                ? `scale(${scale})`
                : "none"
        return <div ref={ref} {...rest} style={{ ...css, transform }} />
    }
)

export const motion = { div: MotionDiv }
