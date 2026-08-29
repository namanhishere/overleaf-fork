import { useProjectContext } from '@/shared/context/project-context'
import { MenuBarDropdown } from '@/shared/components/menu-bar/menu-bar-dropdown'
import { MenuBarOption } from '@/shared/components/menu-bar/menu-bar-option'

// Standalone project tool pages (review, releases, secrets, artifacts,
// AI assistant) cross-link each other via ProjectToolNav but previously
// had no entry point from the editor. Keep the same labels and routes as
// shared/components/project-tool-nav.tsx.
const PROJECT_TOOLS = [
  { href: '/review', label: 'Review' },
  { href: '/releases', label: 'Releases' },
  { href: '/secrets', label: 'Secrets' },
  { href: '/artifacts', label: 'Artifacts' },
  { href: '/ai', label: 'AI assistant' },
]

export const ProjectToolsDropdown = () => {
  const { projectId } = useProjectContext()

  return (
    <MenuBarDropdown
      title="Project tools"
      id="project-tools"
      className="ide-redesign-toolbar-dropdown-toggle-subdued ide-redesign-toolbar-button-subdued"
    >
      {PROJECT_TOOLS.map(tool => (
        <MenuBarOption
          key={tool.href}
          eventKey={tool.href}
          title={tool.label}
          href={`/project/${projectId}${tool.href}`}
        />
      ))}
    </MenuBarDropdown>
  )
}
