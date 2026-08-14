import Topbar from "@/components/dashboard/Topbar";
import Studio from "@/components/studio/Studio";

export default function StudioPage() {
  return (
    <>
      <Topbar title="AI Studio" />
      <div className="flex-1 overflow-y-auto bg-dots p-6">
        <Studio />
      </div>
    </>
  );
}
