import { redirect } from "next/navigation";

/**
 * The Admin section has no index of its own — `/admin` on fraud.packydash.com
 * rewrites to `/antifraud/admin`, which would 404. Send it to the one page the
 * section actually has so a typed URL or a trimmed bookmark lands somewhere.
 */
export default function AdminSectionPage() {
  redirect("/antifraud/admin/deposits");
}
