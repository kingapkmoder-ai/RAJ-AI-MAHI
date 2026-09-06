import React, {useEffect, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {GoogleGenAI, Modality} from "@google/genai";
import "./style.css";

type State = "idle"|"connecting"|"listening"|"speaking";

function pcm16ToAudioBuffer(ctx: AudioContext, data: Uint8Array, sampleRate=24000) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples = data.byteLength / 2;
  const buffer = ctx.createBuffer(1, samples, sampleRate);
  const ch = buffer.getChannelData(0);
  for (let i=0;i<samples;i++) ch[i] = view.getInt16(i*2, true) / 32768;
  return buffer;
}

function App(){
  const [state,setState] = useState<State>("idle");
  const [error,setError] = useState("");
  const sessionRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext|null>(null);
  const streamRef = useRef<MediaStream|null>(null);
  const sourceRef = useRef<AudioBufferSourceNode|null>(null);
  const nextPlayRef = useRef(0);

  const stop = () => {
    try { sessionRef.current?.close?.(); } catch {}
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach(t=>t.stop());
    streamRef.current = null;
    sourceRef.current?.stop?.();
    sourceRef.current = null;
    nextPlayRef.current = 0;
    setState("idle");
  };

  const start = async () => {
    setError("");
    setState("connecting");
    try {
      const key = (import.meta as any).env.VITE_GEMINI_API_KEY;
      if (!key) throw new Error("VITE_GEMINI_API_KEY नहीं मिला। .env में API key डालें।");

      const ai = new GoogleGenAI({apiKey:key});
      const outCtx = new AudioContext({sampleRate:24000});
      const inCtx = new AudioContext({sampleRate:16000});
      audioCtxRef.current = outCtx;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio:{channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true}
      });
      streamRef.current = stream;

      const session = await ai.live.connect({
        model:"gemini-3.1-flash-live-preview",
        config:{
          responseModalities:[Modality.AUDIO],
          systemInstruction:
            "You are Mahi, a smart, witty and confident female voice assistant. " +
            "Speak naturally in Hindi or the user's language. Be playful and warm, " +
            "but never sexual or inappropriate. Keep voice responses concise.",
          tools:[{
            functionDeclarations:[{
              name:"openWebsite",
              description:"Open a normal public website URL requested by the user.",
              parameters:{
                type:"OBJECT",
                properties:{url:{type:"STRING",description:"Full https URL"}},
                required:["url"]
              }
            }]
          }]
        },
        callbacks:{
          onopen:()=>setState("listening"),
          onmessage:async (msg:any)=>{
            if (msg.toolCall?.functionCalls) {
              const responses = [];
              for (const call of msg.toolCall.functionCalls) {
                if (call.name === "openWebsite") {
                  const url = String(call.args?.url || "");
                  if (/^https?:\\/\\//i.test(url)) window.open(url,"_blank","noopener,noreferrer");
                  responses.push({id:call.id,name:call.name,response:{ok:true}});
                }
              }
              if (responses.length) session.sendToolResponse({functionResponses:responses});
            }

            const parts = msg.serverContent?.modelTurn?.parts || [];
            for (const p of parts) {
              const b64 = p.inlineData?.data;
              if (!b64) continue;
              setState("speaking");
              const bin = atob(b64);
              const bytes = Uint8Array.from(bin,c=>c.charCodeAt(0));
              const ctx = audioCtxRef.current!;
              const buf = pcm16ToAudioBuffer(ctx,bytes,24000);
              const src = ctx.createBufferSource();
              src.buffer=buf; src.connect(ctx.destination);
              const when=Math.max(ctx.currentTime,nextPlayRef.current);
              src.start(when);
              nextPlayRef.current=when+buf.duration;
              src.onended=()=>{ if(ctx.currentTime>=nextPlayRef.current-0.05) setState("listening"); };
              sourceRef.current=src;
            }
          },
          onerror:(e:any)=>{setError(e?.message||"Live session error"); stop();},
          onclose:()=>setState("idle")
        }
      });
      sessionRef.current=session;

      const src=inCtx.createMediaStreamSource(stream);
      const processor=inCtx.createScriptProcessor(4096,1,1);
      processor.onaudioprocess=(e)=>{
        if(!sessionRef.current) return;
        const input=e.inputBuffer.getChannelData(0);
        const pcm=new Int16Array(input.length);
        for(let i=0;i<input.length;i++) pcm[i]=Math.max(-1,Math.min(1,input[i]))*32767;
        const bytes=new Uint8Array(pcm.buffer);
        let binary=""; for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
        session.sendRealtimeInput({audio:{data:btoa(binary),mimeType:"audio/pcm;rate=16000"}});
      };
      src.connect(processor); processor.connect(inCtx.destination);
    } catch(e:any) {
      setError(e?.message || "Microphone/API permission error");
      stop();
    }
  };

  useEffect(()=>()=>stop(),[]);

  const active=state!=="idle";
  return <main>
    <div className={"orb "+state}><span></span></div>
    <h1>Mahi <em>AI</em></h1>
    <p className="status">{state==="idle"?"Tap to talk":state==="connecting"?"Connecting…":state==="speaking"?"Mahi is speaking":"Listening…"}</p>
    <button className={"mic "+state} onClick={active?stop:start} aria-label="microphone">
      <span>{active?"■":"🎙"}</span>
    </button>
    <p className="hint">Voice-to-voice • No text chat</p>
    {error && <div className="error">{error}</div>}
  </main>
}

createRoot(document.getElementById("root")!).render(<App/>);