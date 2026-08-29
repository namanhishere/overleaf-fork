import FileTreeRoot from '../../../../../frontend/js/features/file-tree/components/file-tree-root'
import { EditorProviders } from '../../../helpers/editor-providers'
import type { Folder } from '../../../../../types/folder'

describe('FileTree Context Menu Flow', function () {
  beforeEach(function () {
    cy.window().then(win => {
      win.metaAttributesCache.set('ol-user', { id: 'user1' })
    })
  })

  it('opens on contextMenu event', function () {
    const rootFolder = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [{ _id: '456def', name: 'main.tex' }],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder as any}
        projectId="123abc"
        rootDocId="456def"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    cy.findByRole('menu').should('not.exist')
    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu')
  })

  it('should not open on Shift+right-click', function () {
    const rootFolder = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [{ _id: '456def', name: 'main.tex' }],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder as any}
        projectId="123abc"
        rootDocId="456def"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    cy.findByRole('menu').should('not.exist')
    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu', {
      button: 2,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      force: true,
    })
    cy.findByRole('menu').should('not.exist')
  })

  it('should close an already-open menu on Shift+right-click', function () {
    const rootFolder = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [{ _id: '456def', name: 'main.tex' }],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder as any}
        projectId="123abc"
        rootDocId="456def"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu').should('exist')

    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu', {
      button: 2,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      force: true,
    })
    cy.findByRole('menu').should('not.exist')
  })

  it('closes when a new selection is started', function () {
    const rootFolder = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [
          { _id: '456def', name: 'main.tex' },
          { _id: '456def', name: 'foo.tex' },
        ],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder as any}
        projectId="123abc"
        rootDocId="456def"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    cy.findByRole('menu').should('not.exist')
    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu')
    cy.findAllByRole('treeitem', { name: 'foo.tex' }).click()
    cy.findByRole('menu').should('not.exist')
  })

  it("doesn't open in read only mode", function () {
    const rootFolder = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [{ _id: '456def', name: 'main.tex' }],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder as any}
        projectId="123abc"
        rootDocId="456def"
        permissionsLevel="readOnly"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    cy.findAllByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu').should('not.exist')
  })

  it('shows "Open markdown preview" only for .md documents', function () {
    const rootFolder: Folder[] = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [
          { _id: 'md-doc', name: 'notes.md' },
          { _id: 'tex-doc', name: 'main.tex' },
        ],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder}
        projectId="123abc"
        rootDocId="tex-doc"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    // non-markdown doc: no preview item
    cy.findByRole('treeitem', { name: 'main.tex' }).click({ force: true })
    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu')
      .findByRole('menuitem', { name: 'Open markdown preview' })
      .should('not.exist')

    // markdown doc: preview item links to the doc preview page
    cy.findByRole('treeitem', { name: 'notes.md' }).click({ force: true })
    cy.findByRole('treeitem', { name: 'notes.md' }).trigger('contextmenu')
    cy.findByRole('menu')
      .findByRole('menuitem', { name: 'Open markdown preview' })
      .should('have.attr', 'href', '/project/123abc/doc/md-doc/preview')
  })

  it('shows "set main document" item when appropriate', function () {
    const rootFolder = [
      {
        _id: 'root-folder-id',
        name: 'rootFolder',
        docs: [
          { _id: 'main-doc', name: 'main.tex' },
          { _id: 'other-doc', name: 'other.tex' },
        ],
        folders: [],
        fileRefs: [],
      },
    ]

    cy.mount(
      <EditorProviders
        rootFolder={rootFolder as any}
        projectId="123abc"
        rootDocId="main-doc"
      >
        <FileTreeRoot
          refProviders={{}}
          setRefProviderEnabled={cy.stub()}
          setStartedFreeTrial={cy.stub()}
          onSelect={cy.stub()}
          onInit={cy.stub()}
          isConnected
        />
      </EditorProviders>
    )

    cy.findByRole('menu').should('not.exist')

    // main.tex is already the main document
    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu')
      .findByRole('menuitem', { name: 'Set as main document' })
      .should('not.exist')

    // set other.tex as the main document
    cy.findByRole('treeitem', { name: 'other.tex' }).click({ force: true })
    cy.findByRole('treeitem', { name: 'other.tex' }).trigger('contextmenu')

    cy.intercept('POST', '/project/123abc/settings', { statusCode: 204 }).as(
      'update-settings'
    )

    cy.findByRole('menu')
      .findByRole('menuitem', { name: 'Set as main document' })
      .click()

    cy.wait('@update-settings')
      .its('request.body.rootDocId')
      .should('eq', 'other-doc')

    // main.tex is now not the main document
    cy.findByRole('treeitem', { name: 'main.tex' }).trigger('contextmenu')
    cy.findByRole('menu').findByRole('menuitem', {
      name: 'Set as main document',
    })
  })
})
