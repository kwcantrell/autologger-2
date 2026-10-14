// emulates BlobStore.put as uid 1000 (node image umask) + API boot creating sticky media/
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const B='/blobs';
function put(key,bytes){fs.mkdirSync(B+'/.tmp',{recursive:true});fs.mkdirSync(path.dirname(B+'/'+key),{recursive:true});
 const t=B+'/.tmp/put-'+crypto.randomUUID();const fd=fs.openSync(t,'w');fs.writeSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(t,B+'/'+key);}
put('audio/s1/0_a.webm',fs.readFileSync('/fx/seg1.webm'));
put('audio/s1/1_b.webm',fs.readFileSync('/fx/seg2.webm'));
fs.mkdirSync(B+'/media',{recursive:true});fs.chmodSync(B+'/media',0o1777);
console.log('umask',process.umask().toString(8));
