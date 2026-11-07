import { workflowGuides, type WorkflowSection } from "@/lib/ui/workflow-guides";

/** Instructions describe the existing forms. They never infer an operation's readiness. */
export function WorkflowHelp({ section }: { section: WorkflowSection }) {
  const guide = workflowGuides[section];
  return (
    <details className="workflow-help">
      <summary>
        <span>Порядок работы</span>
        <span className="workflow-help-context">{guide.title}</span>
      </summary>
      <ol>
        {guide.steps.map(([title, description]) => (
          <li key={title}><strong>{title}</strong><p>{description}</p></li>
        ))}
      </ol>
      <p className="workflow-help-note">{guide.note}</p>
    </details>
  );
}
