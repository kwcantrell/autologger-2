// worker uid 10001: open input O_NOFOLLOW, stream into ffmpeg pipe:0, write media/<job>/out.webm
const fs=require('fs'),{spawn}=require('child_process');const C=fs.constants;
const job=process.argv[2];
const fd=fs.openSync('/blobs/audio/s1/0_a.webm',C.O_RDONLY|C.O_NOFOLLOW);
fs.mkdirSync('/blobs/media/'+job,0o777); if(process.env.JOBMODE) fs.chmodSync('/blobs/media/'+job,parseInt(process.env.JOBMODE,8));
const ff=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-xerror','-protocol_whitelist','pipe','-f','matroska','-i','pipe:0','-c','copy','-f','webm','pipe:1'],{stdio:['pipe','pipe','inherit']});
fs.createReadStream(null,{fd}).pipe(ff.stdin);
const outFd=fs.openSync('/blobs/media/'+job+'/out.webm',C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o644);
ff.stdout.pipe(fs.createWriteStream(null,{fd:outFd}));
ff.on('close',c=>{const d=fs.statSync('/blobs/media/'+job),f=fs.statSync('/blobs/media/'+job+'/out.webm');
 console.log('ffmpeg rc',c,'dir',(d.mode&0o7777).toString(8),d.uid,'file',(f.mode&0o7777).toString(8),f.uid,f.size);});
