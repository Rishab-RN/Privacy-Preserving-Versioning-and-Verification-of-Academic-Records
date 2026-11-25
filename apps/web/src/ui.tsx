import { Children, cloneElement, isValidElement, useId } from 'react';
import type { ReactNode } from 'react';
export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    Records: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
    Evidence: 'M12 3v12 M8 7l4-4 4 4 M5 13v7h14v-7',
    Review: 'M9 4h11v17H4V4h2 M9 2h6v4H9z M8 13l3 3 5-6',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    lock: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
    check: 'M5 12l4 4L19 6',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.Records} />
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="Records" />
      </span>
      <span>
        Academic Records<small>VERSIONED. VERIFIED. PRIVATE.</small>
      </span>
    </div>
  );
}
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId(),
    labelId = id + '-label',
    hintId = id + '-hint';
  return (
    <div className="field">
      <label id={labelId} htmlFor={id}>
        {label}
      </label>
      {Children.map(children, (child) =>
        isValidElement<{ id?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string }>(
          child,
        ) &&
        typeof child.type === 'string' &&
        ['input', 'select', 'textarea'].includes(child.type)
          ? cloneElement(child, {
              id,
              'aria-labelledby': labelId,
              ...(hint ? { 'aria-describedby': hintId } : {}),
            })
          : child,
      )}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name="Records" />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}
