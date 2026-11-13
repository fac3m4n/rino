import { useEffect, useRef, useState } from "react";
import { Clock3, Info, X } from "lucide-react";
import type { FeedbackNotice } from "./feedback";

export function FeedbackToast({
  notice,
  onDismiss,
}: {
  notice: FeedbackNotice | null;
  onDismiss: () => void;
}) {
  return notice ? (
    <Toast key={notice.id} notice={notice} onDismiss={onDismiss} />
  ) : null;
}
function Toast({
  notice,
  onDismiss,
}: {
  notice: FeedbackNotice;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(6000);
  const paused = hovered || focused;
  useEffect(() => {
    if (notice.kind !== "info" || paused || !visible) return;
    const started = Date.now();
    const timer = setTimeout(() => setVisible(false), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [notice.kind, paused, visible]);
  if (!visible) return null;
  return (
    <section
      className={`feedback-toast feedback-${notice.kind}`}
      role="region"
      aria-label="Feedback"
      aria-live="off"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      {notice.kind === "pending" ? (
        <Clock3 size={18} aria-hidden="true" />
      ) : (
        <Info size={18} aria-hidden="true" />
      )}
      <div
        role={notice.kind === "info" ? "status" : undefined}
        aria-live={notice.kind === "info" ? "polite" : undefined}
      >
        <b>{notice.title}</b>
        {notice.detail && <p>{notice.detail}</p>}
      </div>
      <button aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={18} aria-hidden="true" />
      </button>
    </section>
  );
}
