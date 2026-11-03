export function imageSegment(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('图片须小于 2 MiB');
  const png=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const gif=['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString());
  const webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!png&&!jpg&&!gif&&!webp) throw new Error('不支持的图片格式');
  return {type:'image',data:{file:'base64://'+bytes.toString('base64')}};
}
