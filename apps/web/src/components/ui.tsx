import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X, LoaderCircle } from 'lucide-react';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
const variants = cva('button', {
  variants: {
    variant: {
      default: 'primary',
      secondary: 'secondary',
      ghost: 'ghost',
      destructive: 'destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});
export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof variants> & { asChild?: boolean }
>(({ className, variant, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(variants({ variant }), className)} ref={ref} {...props} />;
});
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-overlay" />
        <DialogPrimitive.Content className="modal-content">
          <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className={description ? 'muted' : 'sr-only'}>
            {description ?? title}
          </DialogPrimitive.Description>
          <DialogPrimitive.Close className="modal-close" aria-label="关闭">
            <X size={20} />
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const inputId = React.useId();
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<any>, { id: inputId })
        : children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Check({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
export function Busy() {
  return (
    <div className="empty" role="status">
      <LoaderCircle className="spin" />
      正在加载…
    </div>
  );
}
