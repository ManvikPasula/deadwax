import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * tailwind-merge is what makes the `className` escape hatch on every primitive actually work:
 * `<Button className="w-full">` OVERRIDES the variant's width rather than appending a second,
 * losing declaration. Without it every primitive needs its own prop for every overridable
 * property.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
