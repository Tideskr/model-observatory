import type { ReactNode } from 'react'
import { Checkbox } from './ui-kit/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui-kit/select'

/* Thin wrappers over the Radix primitives so pages keep reading as markup
 * rather than as component plumbing. Native <select> and <input type=checkbox>
 * are not used anywhere in the product: on Windows the native dropdown ignores
 * every style token and renders an OS menu.
 *
 * Geometry is expressed in Tailwind utilities rather than in our own
 * stylesheets on purpose. Our CSS sits in the `components` cascade layer, so a
 * plain class would silently lose to the utility classes shadcn ships on these
 * triggers. `rounded-sm` resolves to the 6px input radius and `border-input`
 * to the hairline token, both via the @theme bridge in index.css.
 */

const triggerBase =
  'rounded-sm border-input bg-background text-foreground text-sm shadow-none transition-colors ' +
  'hover:border-line-heavy data-[state=open]:border-foreground data-[state=open]:shadow-xs ' +
  '[&_svg:not([class*=text-])]:text-ink-faint'

export function SelectField({
  value,
  onValueChange,
  options,
  icon,
  srLabel,
  width,
}: {
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
  icon?: ReactNode
  srLabel: string
  width?: string
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={srLabel}
        className={`${triggerBase} h-9 px-3`}
        style={width ? { width } : undefined}
      >
        {icon}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/* Labelled variant used inside .field-grid, matched to the 38px input height. */
export function FormSelect({
  label,
  value,
  defaultValue,
  onValueChange,
  options,
  full = false,
}: {
  label: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  options: string[] | { value: string; label: string }[]
  full?: boolean
}) {
  const items = options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  )

  return (
    <div className={full ? 'field is-full' : 'field'}>
      <span>{label}</span>
      <Select
        value={value}
        defaultValue={defaultValue ?? items[0]?.value}
        onValueChange={onValueChange}
      >
        <SelectTrigger aria-label={label} className={`${triggerBase} h-[38px] w-full px-3`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function CheckField({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="check">
      <Checkbox
        checked={checked}
        onCheckedChange={(state) => onCheckedChange(state === true)}
        className="mt-0.5 shrink-0 rounded-[4px]"
      />
      <span>{children}</span>
    </label>
  )
}
