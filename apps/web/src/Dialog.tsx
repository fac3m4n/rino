import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  focusKey,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  focusKey?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current!,
      previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    document.body.classList.add("modal-open");
    return () => {
      dialog.close();
      document.body.classList.remove("modal-open");
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (ref.current) ref.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [open, focusKey]);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="panel-title"
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const targets = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = targets[0],
          last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close.current();
      }}
    >
      <div className="sheet-header">
        <span>{eyebrow ?? "ЯINO"}</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X size={20} />
        </button>
      </div>
      <div className="sheet-content">
        <h2 id="panel-title" tabIndex={-1} ref={heading}>
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
