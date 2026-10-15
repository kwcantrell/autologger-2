// API uid 1000 adopts media/<job>/<name>: open O_NOFOLLOW, fstat handle, copy to .tmp/put-*, fsync, rename into audio/, rm media/<job>/
const fs=require('fs'),crypto=require('crypto');const C=fs.constants;
const [job,name,dest]=process.argv.slice(2);const src=`/blobs/media/${job}/${name}`;
let fd;
try{fd=fs.openSync(src,C.O_RDONLY|C.O_NOFOLLOW);}catch(e){console.log('open FAIL',e.code);process.exit(2);}
const st=fs.fstatSync(fd);
console.log('fstat isFile',st.isFile(),'uid',st.uid,'mode',(st.mode&0o7777).toString(8),'size',st.size);
if(!st.isFile()||st.uid!==10001||st.size>1650*1024*1024){console.log('REJECT fstat check');process.exit(3);}
const t='/blobs/.tmp/put-'+crypto.randomUUID();const out=fs.openSync(t,'w');
const buf=Buffer.alloc(65536);let n,pos=0;while((n=fs.readSync(fd,buf,0,buf.length,pos))>0){fs.writeSync(out,buf,0,n);pos+=n;}
fs.fsyncSync(out);fs.closeSync(out);fs.closeSync(fd);fs.renameSync(t,'/blobs/'+dest);
console.log('copied',pos,'bytes ->',dest,'owner',fs.statSync('/blobs/'+dest).uid);
try{fs.rmSync(`/blobs/media/${job}`,{recursive:true});console.log('rm media/'+job,'OK');}catch(e){console.log('rm media/'+job,'FAIL',e.code);process.exit(4);}
