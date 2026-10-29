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
  busy = false,
  cancelFocus = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  busy?: boolean;
  cancelFocus?: boolean;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-overlay" />
        <DialogPrimitive.Content
          className="modal-content"
          aria-busy={busy}
          onOpenAutoFocus={
            cancelFocus
              ? (event) => {
                  event.preventDefault();
                  (event.currentTarget as HTMLElement)
                    .querySelector<HTMLButtonElement>('[data-cancel]')
                    ?.focus();
                }
              : undefined
          }
        >
          <header className="modal-heading">
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className={description ? 'muted' : 'sr-only'}>
              {description ?? title}
            </DialogPrimitive.Description>
            <DialogPrimitive.Close className="modal-close" aria-label="关闭" disabled={busy}>
              <X size={20} />
            </DialogPrimitive.Close>
          </header>
          <div className="modal-body">{children}</div>
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
        ? React.cloneElement(children as React.ReactElement<any>, {
            id: inputId,
            'aria-describedby': hint ? inputId + '-hint' : undefined,
          })
        : children}
      {hint && <small id={inputId + '-hint'}>{hint}</small>}
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

export function ActionFeedback({ action }: { action: { pending: boolean; error: string } }) {
  return (
    <>
      {action.pending && (
        <p className="form-status" role="status">
          <LoaderCircle size={16} className="spin" />
          正在提交，请稍候…
        </p>
      )}
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
    </>
  );
}

export function QueryFeedback({
  query,
  backgroundOnly = false,
}: {
  query: {
    error?: string;
    refreshError?: string;
    refreshing?: boolean;
    reload: () => Promise<void>;
  };
  backgroundOnly?: boolean;
}) {
  const error = query.refreshError || (!backgroundOnly ? query.error : '');
  if (error)
    return (
      <div className="query-error" role="alert">
        <span>
          {error}
          {query.refreshError ? '，仍显示上次成功的数据。' : ''}
        </span>
        <Button variant="secondary" onClick={() => void query.reload()}>
          重试
        </Button>
      </div>
    );
  return (
    <div className="query-feedback" aria-busy={!!query.refreshing}>
      {query.refreshing && (
        <p className="refresh-status" role="status">
          <LoaderCircle size={14} className="spin" />
          正在刷新…
        </p>
      )}
    </div>
  );
}

const ConfirmContext = React.createContext<(message: string) => Promise<boolean>>(() =>
  Promise.resolve(false),
);
export const useConfirm = () => React.useContext(ConfirmContext);
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = React.useState('');
  const resolve = React.useRef<((value: boolean) => void) | undefined>(undefined);
  const finish = (value: boolean) => {
    resolve.current?.(value);
    resolve.current = undefined;
    setMessage('');
  };
  React.useEffect(() => () => resolve.current?.(false), []);
  return (
    <ConfirmContext.Provider
      value={(text) => {
        resolve.current?.(false);
        setMessage(text);
        return new Promise<boolean>((done) => {
          resolve.current = done;
        });
      }}
    >
      {children}
      <Modal
        open={!!message}
        onOpenChange={() => finish(false)}
        title="确认操作"
        description={message}
        cancelFocus
      >
        <div className="modal-actions">
          <Button data-cancel variant="secondary" onClick={() => finish(false)}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => finish(true)}>
            确认执行
          </Button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}
