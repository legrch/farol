import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Icon } from "./icon";

export function Overlay({
  title,
  children,
  onClose,
  dismissible = true,
  initialFocus,
  className,
  headingIcon,
  headingDescription,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  headingIcon?: string;
  headingDescription?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  // Capture before React commits autofocus descendants, including StrictMode.
  const trigger = useRef(document.activeElement);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const restore = trigger.current;
    dialog.showModal();
    const target = initialFocus?.current;
    if (target && dialog.contains(target)) target.focus();
    return () => {
      dialog.close();
      if (restore instanceof HTMLElement && restore.isConnected)
        restore.focus();
    };
  }, [initialFocus]);
  return (
    <dialog
      ref={ref}
      className={className ? `sheet ${className}` : "sheet"}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) close.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && dismissible)
          close.current();
      }}
    >
      <div className="sheet-content">
        <div className="section-heading">
          {headingIcon ? (
            <div className="update-heading">
              <span className="update-symbol">
                <Icon name={headingIcon} />
              </span>
              <div>
                <h2>{title}</h2>
                {headingDescription}
              </div>
            </div>
          ) : (
            <h2>{title}</h2>
          )}
          {dismissible && (
            <button aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  );
}
