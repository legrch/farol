import {
  designIconPath,
  designIconViewBox,
} from "../../../src/ui/renderer/design-icons";

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox={designIconViewBox} aria-hidden="true">
      <path d={designIconPath(name)} />
    </svg>
  );
}
