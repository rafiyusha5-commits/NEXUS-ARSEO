import { redirect } from "next/navigation";

export default function SuppliersPage() {
  redirect("/counterparties?type=supplier");
}
