import {createRoot} from 'react-dom/client'
import {CentropyAuthProvider} from '../../src/components/centropy/lib/centropy-auth'
import {CentropyWorkspace} from '../../src/components/centropy/shell/CentropyWorkspace'
createRoot(document.getElementById('root')!).render(<CentropyAuthProvider><CentropyWorkspace/></CentropyAuthProvider>)
