import {createRoot} from "react-dom/client"
import {useEffect,useState} from "react"
import {CentropyAuthProvider,useCentropyAuth} from "../../src/components/centropy/lib/centropy-auth"
import {getSupabaseBrowser} from "../../src/lib/centropy/supabase-browser"
import {useCompanyBrainProjection} from "../../src/components/centropy/pe/use-pe-data"
import {WorldExplorer} from "../../src/components/centropy/world/WorldExplorer"
import type {CompanyBrainObjectRef,PeWorldRootRef} from "../../src/components/centropy/pe/contracts"

declare global {interface Window{
 __y4Context:{root:PeWorldRootRef;workId:string}
 __y4Browser?:{signIn:(principal:string,password:string)=>Promise<boolean>;principal:()=>string|undefined;ready:()=>boolean}
}}
function MountedWorld(){
 const auth=useCentropyAuth(),[root,setRoot]=useState(window.__y4Context.root),
  [selected,setSelected]=useState<CompanyBrainObjectRef>({namespace:"core",owner:"@finnor/db",type:"work",id:window.__y4Context.workId}),
  projection=useCompanyBrainProjection(root)
 useEffect(()=>{
  window.__y4Browser={signIn:async(principal,password)=>{
   const client=await getSupabaseBrowser(),result=await client.auth.signInWithPassword({email:principal+"@test.invalid",password})
   return !result.error
  },principal:()=>auth.session?.user.id,ready:()=>Boolean(auth.role==="owner"&&!auth.roleLoading&&!auth.roleError)}
 },[auth])
 return <main><h1>Authenticated WORLD Work, local engineering</h1>
  <p>This host mounts the unchanged product components. It is not a deployed Next server or protected qualification.</p>
  <button type="button" onClick={()=>void auth.signOut()}>Sign out of this browser</button>
  <WorldExplorer root={root} projection={projection.data??null} projectionStatus={projection.status}
   projectionError={projection.error} initialObject={selected} workId={window.__y4Context.workId}
   onSelectRoot={setRoot} onSelectObject={setSelected} onAsk={()=>undefined} onRefresh={projection.reload}/>
 </main>
}
createRoot(document.getElementById("root")!).render(<CentropyAuthProvider><MountedWorld/></CentropyAuthProvider>)
