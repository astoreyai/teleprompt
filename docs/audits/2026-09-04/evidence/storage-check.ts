import {mkdtemp,readFile,writeFile,rename,copyFile,access,chmod} from 'node:fs/promises'
import {AppStore} from '/mnt/projects/teleprompt/src/main/application/app-store.ts'
import {MetadataRepository,DraftRepository} from '/mnt/projects/teleprompt/src/main/persistence/repositories.ts'
import {DocumentImportService} from '/mnt/projects/teleprompt/src/main/documents/import-service.ts'
import {DocumentSaveService} from '/mnt/projects/teleprompt/src/main/documents/save-service.ts'
import {parseDocumentBytes} from '/mnt/projects/teleprompt/src/main/parser/parser-core.ts'
const root='/tmp/teleprompt-audit-2026-09-04';
const importer=new DocumentImportService({parse:(format,bytes,maxOutputChars)=>parseDocumentBytes(format,bytes,{maxOutputChars})});
function storeAt(directory:string){return new AppStore({metadata:new MetadataRepository({directory}),drafts:new DraftRepository(directory+'/drafts')})}
const results=[];
{
const dir=await mkdtemp(root+'/backup-');const source=dir+'/README.md';await copyFile('/mnt/projects/teleprompt/README.md',source);
const store=storeAt(dir);await store.initialize(importer);const doc=await store.addImportedDocument(await importer.loadPath(source));
const content=await readFile('/mnt/projects/teleprompt/SECURITY.md','utf8');await store.updateDocument({id:doc.id,expectedRevision:doc.revision,content});
const saved=await store.saveDocument(doc.id,new DocumentSaveService());
const backup=JSON.parse(await readFile(dir+'/teleprompt-state.v2.json.bak','utf8'));
const draftExists=await access(dir+'/drafts/'+doc.id+'.txt').then(()=>true,()=>false);
await rename(dir+'/teleprompt-state.v2.json',dir+'/primary-preserved.json');
const recovered=storeAt(dir);const issues=await recovered.initialize(importer);
results.push({name:'backup after successful save restores real document',pass:recovered.getSnapshot().documents.length===1,dir,saved,backupDirty:backup.documentRefs[0].dirty,draftExists,restoredDocuments:recovered.getSnapshot().documents.length,issues});
}
{
const dir=await mkdtemp(root+'/unavailable-');const source=dir+'/README.md';await copyFile('/mnt/projects/teleprompt/README.md',source);
const initial=storeAt(dir);await initial.initialize(importer);await initial.addImportedDocument(await importer.loadPath(source));
await rename(source,source+'.temporarily-unavailable');
const missing=storeAt(dir);const issues=await missing.initialize(importer);await missing.flush();
await rename(source+'.temporarily-unavailable',source);
const restored=storeAt(dir);await restored.initialize(importer);
results.push({name:'temporarily unavailable source remains recoverable',pass:restored.getSnapshot().documents.length===1,dir,issues,restoredDocuments:restored.getSnapshot().documents.length,sourceStillExists:await access(source).then(()=>true,()=>false)});
}

{
const dir=await mkdtemp(root+'/metadata-failure-');const source=dir+'/README.md';await copyFile('/mnt/projects/teleprompt/README.md',source);
const store=storeAt(dir);await store.initialize(importer);const doc=await store.addImportedDocument(await importer.loadPath(source));
const content=await readFile('/mnt/projects/teleprompt/SECURITY.md','utf8');
await new DraftRepository(dir+'/drafts').initialize();
let rejection='';await chmod(dir,0o500);
try {await store.updateDocument({id:doc.id,expectedRevision:doc.revision,content});}catch(e){rejection=String(e);}finally{await chmod(dir,0o700);}
const after=store.getDocument(doc.id);const retry=await store.updateDocument({id:doc.id,expectedRevision:doc.revision,content});
results.push({name:'metadata failure preserves client revision contract',pass:after?.revision===doc.revision,dir,rejection,initialRevision:doc.revision,currentRevision:after?.revision,retry});
}

await writeFile(root+'/storage-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
