import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/* Light-only product — the generated `next-themes` lookup is dropped and the
 * theme pinned, rather than pulling in a theme provider we do not use. */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          /* These must reference variables that really exist at runtime.
           * `@theme inline` in index.css only inlines values into utility
           * classes — it does NOT emit bare --popover / --border custom
           * properties, so shadcn's generated defaults resolved to nothing
           * and the toast rendered transparent. Point at tokens.css instead. */
          "--normal-bg": "var(--canvas)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--line)",
          "--border-radius": "var(--r-card)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
