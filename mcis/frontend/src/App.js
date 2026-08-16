import { useState, useRef, useEffect, useCallback } from "react";
import { auth } from "./firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import Auth from "./Auth";
import MemoryPanel from './MemoryPanel';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import GoalsPanel from './GoalsPanel';
import Dashboard from './components/dashboard';
import AmbientBackground from './components/AmbientBackground';
import {
  Brain,
  LayoutDashboard,
  Menu,
  MessageSquarePlus,
  Mic,
  Paperclip,
  Search,
  Send,
  Target,
} from 'lucide-react';

const BASE_URL = process.env.REACT_APP_API_URL || "https://mcis-backend.onrender.com";
const API = `${BASE_URL}/api/chat`;
const authFetch = async (url, options = {}) => {
  const token = await auth.currentUser?.getIdToken();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
};

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState('chat');  // ✅ default landing page is now chat
  
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dailyLimitReached, setDailyLimitReached] = useState(false);
  const [dailyLimitValue, setDailyLimitValue] = useState(null);
  const [dailyRemaining, setDailyRemaining] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedImages, setUploadedImages] = useState([]);   // ✅ CHANGED: array instead of single
  const [imagePreviews, setImagePreviews] = useState([]);     // ✅ CHANGED: array instead of single
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 768);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [hoveredChat, setHoveredChat] = useState(null);
  const [editingChatId, setEditingChatId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [showGoals, setShowGoals] = useState(false);
  const [editingMsgIndex, setEditingMsgIndex] = useState(null);
  const [editingMsgText, setEditingMsgText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [abortController, setAbortController] = useState(null);
  const [userMood, setUserMood] = useState(null);
  const [proactiveMsg, setProactiveMsg] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [chatDraft, setChatDraft] = useState("");

  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const prevUidRef = useRef(null); // ✅ ADDED: tracks which account's data is currently in state

  const theme = {
    bg: "var(--mcis-bg)",
    sidebar: "var(--mcis-sidebar)",
    border: "var(--mcis-border)",
    text: "var(--mcis-text)",
    textMuted: "var(--mcis-muted)",
    inputBg: "var(--mcis-input)",
    aiBubbleBg: "var(--mcis-surface)",
    chatItemHover: "var(--mcis-hover)",
    chatItemActive: "var(--mcis-active)",
    headerBg: "var(--mcis-header)",
  };

  // ✅ ADDED: wipes every piece of per-account state. Called whenever the
  // logged-in uid changes (login, logout, or switching accounts) so that
  // account B never renders account A's chats/messages/goals/memory even
  // for a split second before the fresh fetch completes.
  const resetUserState = () => {
    setChats([]);
    setActiveChatId(null);
    setMessages([]);
    setInput("");
    setUploadedFile(null);
    setUploadedImages([]);
    setImagePreviews([]);
    setSearchQuery("");
    setSearchResults([]);
    setSearching(false);
    setUserMood(null);
    setProactiveMsg(null);
    setSuggestions([]);
    setChatDraft("");
    setDailyLimitReached(false);
    setDailyLimitValue(null);
    setDailyRemaining(null);
    setShowMemory(false);
    setShowGoals(false);
    setEditingChatId(null);
    setEditingTitle("");
    setEditingMsgIndex(null);
    setEditingMsgText("");
    setCurrentPage('chat');
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      const newUid = u ? u.uid : null;
      // ✅ CHANGED: if the account actually changed (different uid, or
      // logged out), clear all previous-account state BEFORE swapping
      // `user`. This is the fix for the "old account's data flashes in
      // the new account" bug.
      if (prevUidRef.current !== newUid) {
        resetUserState();
      }
      prevUidRef.current = newUid;
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  const loadChats = useCallback(async (userId) => {
    try {
      const res = await authFetch(`${API}/chats/${userId}`);
      const data = await res.json();
      if (data.success && data.chats.length > 0) {
        setChats(data.chats);
        setActiveChatId(data.chats[0].id);
        loadMessages(userId, data.chats[0].id);
      } else {
        createNewChat(userId);
      }
    } catch {
      createNewChat(userId);
    }
  }, []);

  useEffect(() => {
    if (user) loadChats(user.uid);
  }, [user, loadChats]);

  useEffect(() => {
    if (user) {
      setTimeout(() => checkProactiveMessage(user.uid), 2000);
    }
  }, [user]);

  useEffect(() => {
    if (messages.length > 0) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (lastUser) {
        const mood = detectMood(lastUser.text);
        if (mood) setUserMood(mood);
      }
    }
  }, [messages]);

  useEffect(() => {
    const handleResize = () => {
      setSidebarOpen(window.innerWidth > 768);
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (input === '' && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input]);

  useEffect(() => {
    if (currentPage === 'chat' && chatDraft) {
      setInput(chatDraft);
      setChatDraft("");
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
        }
      }, 60);
    }
  }, [currentPage, chatDraft]);

  const goToChat = (draft = "") => {
    if (draft) setChatDraft(draft);
    setCurrentPage('chat');
  };

  const detectMood = (text) => {
    const lower = text.toLowerCase();
    if (['stressed', 'anxious', 'worried', 'tension', 'pareshan', 'tensed'].some(w => lower.includes(w))) return 'stressed';
    if (['sad', 'unhappy', 'crying', 'dukhi', 'bura lag'].some(w => lower.includes(w))) return 'sad';
    if (['happy', 'excited', 'great', 'amazing', 'khush', 'mast', 'badhiya'].some(w => lower.includes(w))) return 'happy';
    if (['tired', 'exhausted', 'sleepy', 'thaka', 'bored'].some(w => lower.includes(w))) return 'tired';
    return null;
  };

  const checkProactiveMessage = async (userId) => {
    try {
      const res = await authFetch(`${BASE_URL}/api/goals/${userId}`);
      const data = await res.json();
      if (!data.success || !data.goals.length) return;
      const activeGoals = data.goals.filter(g => g.status === 'active');
      if (!activeGoals.length) return;
      const urgent = activeGoals.find(g => {
        if (!g.target_date) return false;
        const days = Math.ceil((new Date(g.target_date) - new Date()) / (1000 * 60 * 60 * 24));
        return days <= 7 && days > 0;
      });
      if (urgent) {
        const days = Math.ceil((new Date(urgent.target_date) - new Date()) / (1000 * 60 * 60 * 24));
        setProactiveMsg(`Your goal "${urgent.title}" is due in ${days} days! Current progress: ${urgent.progress}%`);
        return;
      }
      const lowProgress = activeGoals.find(g => g.progress < 20);
      if (lowProgress) {
        setProactiveMsg(`You haven't made much progress on "${lowProgress.title}" yet. Want to work on it today?`);
      }
    } catch {}
  };

  const loadMessages = async (userId, chatId) => {
    try {
      const res = await authFetch(`${API}/messages/${userId}/${chatId}`);
      const data = await res.json();
      if (data.success) {
        if (data.messages.length === 0) {
          try {
            const welcomeRes = await authFetch(`${BASE_URL}/api/chat/welcome/${userId}/${chatId}`);
            const welcomeData = await welcomeRes.json();
            setMessages([{ role: "ai", text: welcomeData.welcomeMessage || "Hello! I am MCIS. How can I help you today?" }]);
          } catch {
            setMessages([{ role: "ai", text: "Hello! I am MCIS. How can I help you today?" }]);
          }
        } else {
          const formatted = [];
          data.messages.forEach(m => {
            formatted.push({ role: "user", text: m.message });
            formatted.push({ role: "ai", text: m.response });
          });
          setMessages(formatted);
        }
      }
    } catch {
      setMessages([{ role: "ai", text: "Hello! I am MCIS. How can I help you today?" }]);
    }
    setSuggestions([]);
  };

  const createNewChat = async (userId) => {
    const chatId = `chat_${Date.now()}`;
    try {
      const res = await authFetch(`${API}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, userId, title: "New Chat" })
      });
      const data = await res.json();
      const welcomeMessage = data.welcomeMessage || "Hello! I am MCIS. How can I help you today?";
      setChats(prev => [{ id: chatId, title: "New Chat", created_at: new Date().toISOString() }, ...prev]);
      setActiveChatId(chatId);
      setMessages([{ role: "ai", text: welcomeMessage }]);
      setUploadedFile(null);
      setUploadedImages([]);
      setImagePreviews([]);
      setSuggestions([]);
    } catch {
      setMessages([{ role: "ai", text: "Hello! I am MCIS. How can I help you today?" }]);
    }
  };

  const handleStop = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setLoading(false);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 } });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (audioChunksRef.current.length === 0) return;
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (audioBlob.size < 1000) return;
        const formData = new FormData();
        formData.append('audio', audioBlob, `recording.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
        try {
          const res = await authFetch(`${BASE_URL}/api/voice/transcribe`, { method: 'POST', body: formData });
          const data = await res.json();
          if (data.success && data.text) setInput(data.text.trim());
        } catch (err) { console.error('Transcription failed:', err); }
      };
      mediaRecorder.start(100);
      setIsRecording(true);
    } catch (err) {
      if (err.name === 'NotAllowedError') alert('Please allow microphone access');
      else alert('Microphone error: ' + err.message);
    }
  };

  const searchChats = async (query) => {
    if (!query.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const res = await authFetch(`${API}/search/${user.uid}?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.success) setSearchResults(data.results);
    } catch { setSearchResults([]); }
    setSearching(false);
  };

  const handleSearchResultClick = async (result) => {
    const existingChat = chats.find(c => c.id === result.chat_id);
    if (!existingChat) {
      try {
        const res = await authFetch(`${API}/chats/${user.uid}`);
        const data = await res.json();
        if (data.success) setChats(data.chats);
      } catch {}
    }
    setActiveChatId(result.chat_id);
    await loadMessages(user.uid, result.chat_id);
    setSearchQuery("");
    setSearchResults([]);
    if (window.innerWidth <= 768) setSidebarOpen(false);
  };

  const switchChat = async (chatId) => {
    setActiveChatId(chatId);
    setUploadedFile(null); setUploadedImages([]); setImagePreviews([]);
    setEditingMsgIndex(null); setShowAttachMenu(false);
    setSuggestions([]);
    if (window.innerWidth <= 768) setSidebarOpen(false);
    await loadMessages(user.uid, chatId);
  };

  const handleDeleteChat = async (e, chatId) => {
    e.stopPropagation();
    try {
      await authFetch(`${API}/chats/${chatId}`, { method: "DELETE" });
      setChats(prev => {
        const updated = prev.filter(c => c.id !== chatId);
        if (updated.length === 0) { createNewChat(user.uid); return []; }
        if (chatId === activeChatId) { switchChat(updated[0].id); setActiveChatId(updated[0].id); }
        return updated;
      });
    } catch {}
  };

  const startRenaming = (e, chat) => { e.stopPropagation(); setEditingChatId(chat.id); setEditingTitle(chat.title); };

  const saveRename = async (chatId) => {
    if (!editingTitle.trim()) return;
    try {
      await authFetch(`${API}/chats/${chatId}/rename`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: editingTitle.trim() }) });
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, title: editingTitle.trim() } : c));
    } catch {}
    setEditingChatId(null);
  };

  const handleFileSelect = (e) => { const file = e.target.files[0]; if (!file) return; setUploadedFile(file); setUploadedImages([]); setImagePreviews([]); e.target.value = ''; };

  // ✅ CHANGED: multi-image select (max 5, matches Groq vision limit)
  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files).slice(0, 5);
    if (!files.length) return;
    setUploadedImages(files);
    setUploadedFile(null);
    const readers = files.map(file => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.readAsDataURL(file);
    }));
    Promise.all(readers).then(setImagePreviews);
    e.target.value = '';
  };

  // ✅ CHANGED: paste appends to the images array (supports pasting multiple screenshots one by one)
  const handlePaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        setUploadedImages(prev => [...prev, file].slice(0, 5));
        setUploadedFile(null);
        const reader = new FileReader();
        reader.onload = (ev) => setImagePreviews(prev => [...prev, ev.target.result].slice(0, 5));
        reader.readAsDataURL(file);
        break;
      }
    }
  };

  // ✅ CHANGED: sends all images together to /api/image in one request
  const handleImageUpload = async () => {
    if (!uploadedImages.length || !activeChatId) return;
    const instruction = input.trim(); // empty chhodo agar user kuch na likhe
    const displayText = instruction || `${uploadedImages.length} image(s)`; // sirf UI me dikhane ke liye
    const firstPreviewUrl = imagePreviews[0];
    const imageCount = uploadedImages.length;
    setInput(''); setUploadedImages([]); setImagePreviews([]); setLoading(true);
    setSuggestions([]);
    setMessages(prev => [...prev, { role: 'user', text: displayText, image: firstPreviewUrl }, { role: 'ai', text: 'Analyzing your image(s)...' }]);
    try {
      const formData = new FormData();
      uploadedImages.forEach(file => formData.append('images', file));
      formData.append('userId', user.uid);
      formData.append('chatId', activeChatId);
      formData.append('message', instruction); // backend ko empty ya jo user ne likha wahi jaye
      const res = await authFetch(`${BASE_URL}/api/image`, { method: 'POST', body: formData });
      const data = await res.json();
      setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: 'ai', text: data.success ? data.response : (data.error || 'Could not analyze image.') }; return u; });
      setChats(prev => prev.map(c => c.id === activeChatId && c.title === 'New Chat' ? { ...c, title: `Image: ${imageCount} file(s)` } : c));
    } catch {
      setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: 'ai', text: 'Image upload failed.' }; return u; });
    }
    setLoading(false);
  };

  const handleEditMessage = async (msgIndex) => {
    if (!editingMsgText.trim()) return;
    const newText = editingMsgText.trim();
    setEditingMsgIndex(null); setLoading(true);
    setSuggestions([]);
    setMessages(prev => [...prev.slice(0, msgIndex), { role: "user", text: newText }, { role: "ai", text: "" }]);
    try {
      const res = await authFetch(`${API}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: user.uid, chatId: activeChatId, newMessage: newText }) });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const d = line.replace('data: ', '');
          if (d === '[DONE]') break;
          try {
            const p = JSON.parse(d);
            fullText += p.text || '';
            setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: fullText }; return u; });
          } catch {}
        }
      }
    } catch {
      setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: "Something went wrong." }; return u; });
    }
    setLoading(false);
  };

  // Reads X-Daily-Remaining header on every successful stream response, and
  // detects the 429 daily-limit response from checkDailyLimit middleware.
  // Returns 'daily' | 'rate' | null so callers can react differently.
  const handleDailyLimitResponse = async (res) => {
    const remainingHeader = res.headers.get('X-Daily-Remaining');
    if (remainingHeader !== null) setDailyRemaining(Number(remainingHeader));

    if (res.status !== 429) return null;

    let data = {};
    try { data = await res.json(); } catch {}

    if (data.limitReached) {
      setDailyLimitReached(true);
      setDailyLimitValue(data.dailyLimit || null);
      return 'daily';
    }

    // Plain per-minute rate limit — not the daily cap
    setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: data.error || "Too many requests. Please wait a minute." }; return u; });
    return 'rate';
  };

  const handleRegenerate = async () => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    if (!lastUserMsg || loading) return;
    setLoading(true);
    setSuggestions([]);
    setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: "" }; return u; });
    try {
      const controller = new AbortController();
      setAbortController(controller);
      const res = await authFetch(`${API}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: user.uid, message: lastUserMsg.text, chatId: activeChatId }), signal: controller.signal });
      const limitResult = await handleDailyLimitResponse(res);
      if (limitResult === 'daily') {
        setMessages(prev => { const u = [...prev]; u.pop(); return u; }); // remove the empty placeholder AI message — banner shows the limit instead
        setLoading(false); setAbortController(null);
        return;
      }
      if (limitResult === 'rate') { setLoading(false); setAbortController(null); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const d = line.replace('data: ', '');
          if (d === '[DONE]') break;
          try {
            const p = JSON.parse(d);
            if (p.suggestions) { setSuggestions(p.suggestions); continue; }
            fullText += p.text || '';
            setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: fullText }; return u; });
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: "Something went wrong." }; return u; });
      }
    }
    setLoading(false); setAbortController(null);
  };

  const sendMessage = async () => {
    if ((!input.trim() && !uploadedFile && !uploadedImages.length) || loading || !activeChatId) return;
    setShowAttachMenu(false);
    setSuggestions([]);
    if (uploadedImages.length) { await handleImageUpload(); return; }
    const userMessage = input.trim();
    setInput("");
    setLoading(true);
    if (uploadedFile) {
      const fileName = uploadedFile.name;
      const instruction = userMessage || "Please analyze this file and give me a detailed summary";
      setMessages(prev => [...prev, { role: "user", text: `File: ${fileName}\n${instruction}` }, { role: "ai", text: "Reading your file..." }]);
      setUploadedFile(null);
      try {
        const formData = new FormData();
        formData.append('file', uploadedFile); formData.append('userId', user.uid);
        formData.append('chatId', activeChatId); formData.append('message', instruction);
        const res = await authFetch(`${BASE_URL}/api/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: data.success ? data.response : "Could not read the file." }; return u; });
        setChats(prev => prev.map(c => c.id === activeChatId && c.title === "New Chat" ? { ...c, title: `File: ${fileName.slice(0, 22)}` } : c));
      } catch {
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: "File upload failed." }; return u; });
      }
      setLoading(false);
      return;
    }
    setMessages(prev => [...prev, { role: "user", text: userMessage }, { role: "ai", text: "" }]);
    try {
      const controller = new AbortController();
      setAbortController(controller);
      const res = await authFetch(`${API}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: user.uid, message: userMessage, chatId: activeChatId }), signal: controller.signal });
      const limitResult = await handleDailyLimitResponse(res);
      if (limitResult === 'daily') {
        setMessages(prev => { const u = [...prev]; u.pop(); return u; }); // remove empty AI placeholder — banner shows the limit instead
        setLoading(false); setAbortController(null);
        return;
      }
      if (limitResult === 'rate') { setLoading(false); setAbortController(null); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const d = line.replace('data: ', '');
          if (d === '[DONE]') break;
          try {
            const p = JSON.parse(d);
            if (p.titleUpdate) { setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, title: p.titleUpdate } : c)); continue; }
            if (p.suggestions) { setSuggestions(p.suggestions); continue; }
            fullText += p.text || '';
            setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: fullText }; return u; });
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "ai", text: "Something went wrong." }; return u; });
      }
    }
    setLoading(false); setAbortController(null);
  };

  if (authLoading) return <div className="mcis-loading-screen"><div className="mcis-loading-logo">M</div><span className="mcis-loading-text">Preparing your intelligence workspace</span><div className="mcis-loading-bar"><span /></div></div>;
  if (!user) return <Auth onLogin={setUser} />;

  // ✅ IF DASHBOARD PAGE - SHOW DASHBOARD
  if (currentPage === 'dashboard') {
    return (
      <>
        <AmbientBackground />
        <Dashboard
          userId={user.uid}
          userName={user.displayName || user.email}
          onGoToChat={goToChat}
          onLogout={async () => {
            await signOut(auth);
            setCurrentPage('dashboard');
          }}
        />
      </>
    );
  }

  // ✅ OTHERWISE SHOW CHAT PAGE (your existing code)
  return (
    <>
    <AmbientBackground />
    <div className="mcis-chat-shell" style={{ display: "flex", height: "100dvh", background: theme.bg, color: theme.text, overflow: "hidden", position: "fixed", top: 0, left: 0, right: 0, bottom: 0 }} onClick={() => setShowAttachMenu(false)}>

      {sidebarOpen && window.innerWidth <= 768 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 998 }} onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className="mcis-chat-sidebar" style={{ background: theme.sidebar, borderRight: `1px solid ${theme.border}`, display: "flex", flexDirection: "column", transition: "width 0.3s", flexShrink: 0, width: sidebarOpen ? (isMobile ? '86vw' : 284) : 0, maxWidth: 320, overflow: "hidden", position: window.innerWidth <= 768 ? 'fixed' : 'relative', zIndex: window.innerWidth <= 768 ? 999 : 1, height: '100dvh', left: 0, top: 0 }}>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 16px", borderBottom: `1px solid ${theme.border}` }}>
          <div className="mcis-brand-mark" style={{ width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "900", fontSize: 14, flexShrink: 0 }}>M</div>
          <span className="mcis-gradient-text" style={{ flex: 1, fontWeight: 700, fontSize: 17 }}>MCIS</span>
          <button style={{ background: "transparent", border: "none", color: theme.textMuted, cursor: "pointer", fontSize: 16 }} onClick={() => setSidebarOpen(false)}>✕</button>
        </div>

        <button className="mcis-sidebar-new-chat" style={{ margin: "14px 16px 8px", background: "var(--mcis-primary)", border: "none", borderRadius: 10, padding: "11px", color: "#ffffff", fontWeight: "bold", cursor: "pointer", fontSize: 14, boxShadow: "var(--mcis-glow)" }} onClick={() => createNewChat(user.uid)}><MessageSquarePlus size={17} /> New chat</button>
        <div className="mcis-sidebar-section-label">Intelligence</div>
        <button className="mcis-sidebar-nav-btn" onClick={() => setShowMemory(true)}><Brain size={16} /> Memory center</button>
        <button className="mcis-sidebar-nav-btn" onClick={() => setShowGoals(true)}><Target size={16} /> Goals</button>
        
        <div className="mcis-sidebar-search" style={{ margin: "0 12px 8px" }}>
          <div className="mcis-search-box" style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 10px", color: theme.textMuted }}><Search size={15} /><input aria-label="Search chats" style={{ width: "100%", background: "transparent", border: "none", padding: "9px 0", color: theme.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} placeholder="Search conversations" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); searchChats(e.target.value); }} /></div>
          {searching && <div style={{ color: theme.textMuted, fontSize: 12, padding: "4px" }}>Searching...</div>}
          {searchResults.length > 0 && (
            <div style={{ marginTop: 4, maxHeight: 200, overflowY: "auto" }}>
              {searchResults.map((result, i) => (
                <div key={i} style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer", marginBottom: 3, background: activeChatId === result.chat_id ? theme.chatItemActive : theme.inputBg, border: `1px solid ${theme.border}` }} onClick={() => handleSearchResultClick(result)}>
                  <div style={{ fontSize: 11, color: "#6c63ff", fontWeight: "bold", marginBottom: 2 }}>{result.chat_title || 'Untitled'}</div>
                  <div style={{ fontSize: 11, color: theme.textMuted }}>{result.message.length > 60 ? result.message.slice(0, 60) + '...' : result.message}</div>
                </div>
              ))}
            </div>
          )}
          {!searching && searchQuery && searchResults.length === 0 && <div style={{ color: theme.textMuted, fontSize: 12, padding: "4px" }}>No results found</div>}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px" }}>
          <div className="mcis-sidebar-section-label">Recent chats</div>
          {chats.map(chat => (
            <div className={`mcis-chat-list-item ${chat.id === activeChatId ? 'mcis-chat-list-item--active' : ''}`} key={chat.id} style={{ background: chat.id === activeChatId ? theme.chatItemActive : hoveredChat === chat.id ? theme.chatItemHover : "transparent" }}
              onClick={() => switchChat(chat.id)} onMouseEnter={() => setHoveredChat(chat.id)} onMouseLeave={() => setHoveredChat(null)}>
              {editingChatId === chat.id ? (
                <input style={{ flex: 1, background: theme.inputBg, border: "1px solid #6c63ff", borderRadius: 4, padding: "4px 8px", color: theme.text, fontSize: 13, outline: "none" }} value={editingTitle} onChange={e => setEditingTitle(e.target.value)} onBlur={() => saveRename(chat.id)} onKeyDown={e => e.key === "Enter" && saveRename(chat.id)} onClick={e => e.stopPropagation()} autoFocus />
              ) : (
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{chat.title}</span>
              )}
              {hoveredChat === chat.id && editingChatId !== chat.id && (
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button style={{ background: "transparent", border: "1px solid #6c63ff", borderRadius: 4, color: "#6c63ff", cursor: "pointer", fontSize: 10, padding: "2px 6px" }} onClick={(e) => startRenaming(e, chat)}>Rename</button>
                  <button style={{ background: "transparent", border: "1px solid #ff6b6b", borderRadius: 4, color: "#ff6b6b", cursor: "pointer", fontSize: 10, padding: "2px 6px" }} onClick={(e) => handleDeleteChat(e, chat.id)}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: "16px", borderTop: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
          <button style={{ width: "100%", background: "transparent", border: `1px solid ${theme.border}`, borderRadius: 8, padding: "8px", color: theme.text, cursor: "pointer", fontSize: 13 }} onClick={() => signOut(auth)}>Logout</button>
        </div>
      </div>

      {/* Main */}
      <div className="mcis-chat-main" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, height: "100dvh" }}>

        {/* Header */}
        <div className="mcis-chat-header" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: theme.headerBg, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, zIndex: 100, position: "sticky", top: 0 }}>
          <button aria-label="Toggle conversation sidebar" style={{ background: "transparent", border: "none", color: theme.textMuted, cursor: "pointer", fontSize: 20, flexShrink: 0 }} onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
          <div className="mcis-gradient-text" style={{ fontWeight: 700, fontSize: 18, flexShrink: 0 }}>MCIS</div>
          {!isMobile && (
            <div style={{ flex: 1, fontSize: 11, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>AI workspace with persistent memory</div>
          )}
          {isMobile && <div style={{ flex: 1 }} />}
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", flexShrink: 0, boxShadow: "0 0 0 4px rgba(16,185,129,0.12)" }}></div>
          {userMood && !isMobile && (
            <div style={{ fontSize: 11, color: userMood === 'stressed' ? '#f7b731' : userMood === 'sad' ? '#fc5c65' : userMood === 'happy' ? '#00ff88' : '#888', background: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: '3px 10px', flexShrink: 0 }}>
              {userMood === 'stressed' ? 'Stressed' : userMood === 'sad' ? 'Sad' : userMood === 'happy' ? 'Happy' : 'Tired'}
            </div>
          )}
          
          <button 
            onClick={() => setCurrentPage('dashboard')}
            style={{ background: "var(--mcis-subtle)", border: `1px solid ${theme.border}`, borderRadius: 20, padding: isMobile ? "6px 10px" : "7px 13px", color: theme.text, cursor: "pointer", fontSize: 12, flexShrink: 0 }}
          >
            <LayoutDashboard size={15} /> {!isMobile && 'Workspace'}
          </button>

          </div>

        {/* Messages */}
        <div className="mcis-message-scroll" style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px 10px" : "22px clamp(16px, 4vw, 56px)", display: "flex", flexDirection: "column", WebkitOverflowScrolling: "touch" }}>

          {messages.length === 1 && messages[0].role === "ai" && (
            <div className="mcis-welcome">
              <div className="mcis-welcome-icon">M</div>
              <h2>{proactiveMsg ? "Welcome back." : "Where should we pick up?"}</h2>
              <p>{messages[0].text}</p>
              <div className="mcis-prompt-grid">
                {[
                  "Summarize what you remember about me",
                  "Help me plan my day around my active goals",
                  "Draft a message I've been putting off",
                  "Walk me through a decision I'm stuck on",
                ].map((chip, i) => (
                  <button
                    key={i}
                    className="mcis-prompt-chip"
                    onClick={() => {
                      setInput(chip);
                      setTimeout(() => textareaRef.current?.focus(), 0);
                    }}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          {proactiveMsg && (
            <div style={{ marginBottom: 16, background: "linear-gradient(135deg, rgba(108,99,255,0.15), rgba(62,207,207,0.15))", border: "1px solid #6c63ff", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--mcis-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", fontSize: 12, color: "#fff", flexShrink: 0 }}>M</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: "#6c63ff", fontWeight: "bold", marginBottom: 4 }}>MCIS reminded you</div>
                <div style={{ fontSize: 13, color: theme.text, lineHeight: 1.5 }}>{proactiveMsg}</div>
              </div>
              <button style={{ background: "transparent", border: "none", color: theme.textMuted, cursor: "pointer", fontSize: 16, padding: "0 4px" }} onClick={() => setProactiveMsg(null)}>✕</button>
            </div>
          )}

          {messages.filter((_, idx) => !(messages.length === 1 && idx === 0 && messages[0].role === "ai")).map((msg, i) => (
            <div className="mcis-chat-message" key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", marginBottom: msg.role === "user" ? 28 : 16 }}>
              {msg.role === "ai" && <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--mcis-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", fontSize: 12, color: "#fff", marginRight: 8, flexShrink: 0, alignSelf: "flex-start" }}>M</div>}
              <div style={{ position: 'relative', maxWidth: isMobile ? '88%' : '78%', minWidth: 0 }}>
                {editingMsgIndex === i ? (
                  <div style={{ background: theme.aiBubbleBg, border: '1px solid #6c63ff', borderRadius: 12, padding: '12px' }}>
                    <textarea style={{ width: '100%', background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px', color: theme.text, fontSize: 14, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} value={editingMsgText} onChange={e => setEditingMsgText(e.target.value)} rows={3} autoFocus />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button style={{ background: 'var(--mcis-primary)', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', fontSize: 13, padding: '6px 16px' }} onClick={() => handleEditMessage(i)}>Save & Resend</button>
                      <button style={{ background: 'transparent', border: '1px solid #555', borderRadius: 8, color: '#888', cursor: 'pointer', fontSize: 13, padding: '6px 16px' }} onClick={() => setEditingMsgIndex(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={msg.role === "user" ? { background: "var(--mcis-primary)", borderRadius: "18px 6px 18px 18px", padding: "12px 15px", lineHeight: 1.7, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#fff", boxShadow: "var(--mcis-glow)" } : { background: theme.aiBubbleBg, border: `1px solid ${theme.border}`, borderRadius: "6px 18px 18px 18px", padding: "13px 17px", lineHeight: 1.7, fontSize: 14, wordBreak: "break-word", color: theme.text, boxShadow: "var(--mcis-card-shadow)" }}>
                    {msg.image && <img src={msg.image} alt="uploaded" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, marginBottom: 8, display: 'block' }} />}
                    {msg.role === "user" ? msg.text : (
                      <ReactMarkdown components={{
                        code({ node, inline, className, children, ...props }) {
                          const match = /language-(\w+)/.exec(className || '');
                          return !inline && match ? (
                            <div style={{ marginBottom: 16, maxWidth: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e1e2e', padding: '8px 14px', borderRadius: '10px 10px 0 0', fontSize: 12, color: '#888' }}>
                                <span style={{ color: '#6c63ff', fontWeight: 'bold' }}>{match[1]}</span>
                                <button style={{ background: 'transparent', border: '1px solid #444', borderRadius: 4, color: '#aaa', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }} onClick={() => navigator.clipboard.writeText(String(children))}>Copy</button>
                              </div>
                              <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div" customStyle={{ margin: 0, borderRadius: '0 0 10px 10px', fontSize: 13, overflowX: 'auto', maxWidth: '100%', width: '100%', boxSizing: 'border-box' }} {...props}>{String(children).replace(/\n$/, '')}</SyntaxHighlighter>
                            </div>
                          ) : <code style={{ background: 'var(--mcis-code-bg)', borderRadius: 4, padding: '2px 7px', fontSize: 13, fontFamily: 'monospace', color: 'var(--mcis-text)' }} {...props}>{children}</code>;
                        },
                        p: ({ children }) => <p style={{ margin: '0 0 8px 0', lineHeight: 1.5, fontSize: 14 }}>{children}</p>,
                        ul: ({ children }) => <ul style={{ paddingLeft: 20, margin: '2px 0 8px 0' }}>{children}</ul>,
                        ol: ({ children }) => <ol style={{ paddingLeft: 20, margin: '2px 0 8px 0' }}>{children}</ol>,
                        li: ({ children }) => <li style={{ marginBottom: 3, lineHeight: 1.4, fontSize: 14 }}>{children}</li>,
                        h1: ({ children }) => <h1 style={{ fontSize: 20, fontWeight: '700', margin: '20px 0 10px', color: 'var(--mcis-accent)', borderBottom: `1px solid ${theme.border}`, paddingBottom: 6 }}>{children}</h1>,
                        h2: ({ children }) => <h2 style={{ fontSize: 17, fontWeight: '700', margin: '18px 0 8px', color: 'var(--mcis-accent)' }}>{children}</h2>,
                        h3: ({ children }) => <h3 style={{ fontSize: 15, fontWeight: '600', margin: '14px 0 6px', color: 'var(--mcis-accent)' }}>{children}</h3>,
                        strong: ({ children }) => <strong style={{ fontWeight: '700', color: theme.text }}>{children}</strong>,
                        blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid var(--mcis-accent)', paddingLeft: 14, margin: '12px 0', color: theme.textMuted, fontStyle: 'italic', background: 'var(--mcis-subtle)', borderRadius: '0 8px 8px 0', padding: '10px 14px' }}>{children}</blockquote>,
                        hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${theme.border}`, margin: '16px 0' }} />,
                        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--mcis-accent)', textDecoration: 'none', borderBottom: '1px solid var(--mcis-accent-soft)' }}>{children}</a>,
                      }}>
                        {msg.text}
                      </ReactMarkdown>
                    )}
                    {loading && i === messages.length - 1 && msg.role === "ai" && <span style={{ marginLeft: 2, fontWeight: "bold" }}>|</span>}
                  </div>
                )}

                {msg.role === "ai" && msg.text && !msg.text.includes('Analyzing') && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button style={{ background: 'transparent', border: `1px solid ${copiedIndex === i ? '#00ff88' : theme.border}`, borderRadius: 6, color: copiedIndex === i ? '#00ff88' : theme.textMuted, cursor: 'pointer', fontSize: 11, padding: '3px 10px' }}
                      onClick={() => { navigator.clipboard.writeText(msg.text); setCopiedIndex(i); setTimeout(() => setCopiedIndex(null), 2000); }}>
                      {copiedIndex === i ? '✓ Copied' : 'Copy'}
                    </button>
                    {i === messages.length - 1 && (
                      <button style={{ background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 6, color: theme.textMuted, cursor: 'pointer', fontSize: 11, padding: '3px 10px' }} onClick={handleRegenerate} disabled={loading}>Regenerate</button>
                    )}
                  </div>
                )}

                {msg.role === "user" && editingMsgIndex !== i && (
                  <button style={{ position: 'absolute', bottom: -22, right: 4, background: 'rgba(108,99,255,0.15)', border: '1px solid #6c63ff', borderRadius: 6, color: '#6c63ff', cursor: 'pointer', fontSize: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => { setEditingMsgIndex(i); setEditingMsgText(msg.text); }}>Edit</button>
                )}
              </div>
            </div>
          ))}

          {suggestions.length > 0 && !loading && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, marginTop: 4, paddingLeft: isMobile ? 6 : 36 }}>
              {suggestions.map((s, i) => (
                <button key={i}
                  style={{ background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 20, padding: '8px 14px', color: theme.textMuted, cursor: 'pointer', fontSize: 12, textAlign: 'left' }}
                  onClick={() => { setInput(s); setSuggestions([]); }}
                  onMouseEnter={e => { e.target.style.borderColor = '#6c63ff'; e.target.style.color = '#6c63ff'; }}
                  onMouseLeave={e => { e.target.style.borderColor = theme.border; e.target.style.color = theme.textMuted; }}
                >{s}</button>
              ))}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* File Preview */}
        {uploadedFile && (
          <div style={{ margin: "0 12px 8px", background: theme.aiBubbleBg, border: '1px solid #6c63ff', borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: "bold", color: "#6c63ff", background: "rgba(108,99,255,0.15)", borderRadius: 6, padding: "3px 8px" }}>File</span>
            <span style={{ fontSize: 13, color: "#6c63ff", fontWeight: "bold", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uploadedFile.name}</span>
            <button style={{ background: "transparent", border: "1px solid #ff6b6b", borderRadius: 6, color: "#ff6b6b", cursor: "pointer", fontSize: 12, padding: "3px 8px" }} onClick={() => setUploadedFile(null)}>✕</button>
          </div>
        )}

        {/* ✅ CHANGED: Multi-Image Preview — shows all thumbnails, can remove individually */}
        {uploadedImages.length > 0 && (
          <div style={{ margin: "0 12px 8px", background: theme.aiBubbleBg, border: '1px solid #6c63ff', borderRadius: 12, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: theme.textMuted }}>{uploadedImages.length} image{uploadedImages.length > 1 ? 's' : ''} attached — type your question and press Send</span>
              <button style={{ background: "transparent", border: "1px solid #ff6b6b", borderRadius: 6, color: "#ff6b6b", cursor: "pointer", fontSize: 12, padding: "3px 8px" }} onClick={() => { setUploadedImages([]); setImagePreviews([]); }}>Clear all</button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {imagePreviews.map((src, idx) => (
                <div key={idx} style={{ position: "relative" }}>
                  <img src={src} alt={`preview-${idx}`} style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8 }} />
                  <button
                    style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#ff6b6b", border: "none", color: "#fff", cursor: "pointer", fontSize: 10, lineHeight: "18px", padding: 0 }}
                    onClick={() => {
                      setUploadedImages(prev => prev.filter((_, i) => i !== idx));
                      setImagePreviews(prev => prev.filter((_, i) => i !== idx));
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Attach Menu */}
        {showAttachMenu && (
          <div style={{ position: "absolute", bottom: 72, left: 12, right: isMobile ? 12 : 'auto', background: theme.sidebar, border: `1px solid ${theme.border}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.3)", zIndex: 200, minWidth: isMobile ? 'auto' : 220, maxHeight: '70vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <button style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", width: "100%", padding: "14px 18px", background: "transparent", border: "none", color: theme.text, cursor: "pointer" }} onClick={() => { fileInputRef.current.click(); setShowAttachMenu(false); }}>
              <span style={{ fontSize: 14, fontWeight: "bold", marginBottom: 3 }}>File</span>
              <span style={{ fontSize: 12, color: theme.textMuted }}>PDF, Word, Text document</span>
            </button>
            <div style={{ height: 1, background: theme.border, margin: "0 14px" }} />
            <button style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", width: "100%", padding: "14px 18px", background: "transparent", border: "none", color: theme.text, cursor: "pointer" }} onClick={() => { imageInputRef.current.click(); setShowAttachMenu(false); }}>
              <span style={{ fontSize: 14, fontWeight: "bold", marginBottom: 3 }}>Photo</span>
              <span style={{ fontSize: 12, color: theme.textMuted }}>Image(s) from gallery or camera — up to 5</span>
            </button>
          </div>
        )}

        {/* Input Bar */}
        <div className="mcis-input-bar" style={{ display: "flex", gap: isMobile ? 6 : 8, padding: isMobile ? "8px 8px" : "12px clamp(12px, 3vw, 40px)", background: theme.headerBg, borderTop: `1px solid ${theme.border}`, alignItems: "center", flexShrink: 0, zIndex: 100, position: "sticky", bottom: 0 }} onClick={e => e.stopPropagation()}>
          <input type="file" ref={fileInputRef} onChange={handleFileSelect} style={{ display: "none" }} accept="*/*" />
          <input type="file" ref={imageInputRef} onChange={handleImageSelect} style={{ display: "none" }} accept="image/*" multiple />

          <button aria-label="Attach a file or image" style={{ width: 38, height: 38, borderRadius: "50%", border: "1px solid var(--mcis-primary-solid)", background: "transparent", color: "var(--mcis-primary-solid)", fontSize: 24, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
            onClick={(e) => { e.stopPropagation(); setShowAttachMenu(prev => !prev); }} disabled={loading}><Paperclip size={17} /></button>

          <textarea
            ref={textareaRef}
            style={{ flex: 1, background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: 18, padding: "11px 16px", color: theme.text, fontSize: 16, outline: "none", minWidth: 0, resize: "none", overflowY: "auto", minHeight: 44, maxHeight: 200, lineHeight: 1.5, fontFamily: "inherit", whiteSpace: "pre-wrap" }}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
            }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
              if (e.key === "Escape") setShowAttachMenu(false);
            }}
            onPaste={handlePaste}
            onClick={() => setShowAttachMenu(false)}
            placeholder={dailyLimitReached ? "Daily limit reached — come back tomorrow" : isRecording ? "Recording..." : uploadedImages.length ? "Ask about this image..." : uploadedFile ? "Type instruction..." : "Message MCIS..."}
            disabled={loading || dailyLimitReached}
            rows={1}
          />

          <button
            style={{ borderRadius: 20, padding: isMobile ? "9px 10px" : "9px 14px", cursor: "pointer", fontSize: 13, fontWeight: "bold", flexShrink: 0, whiteSpace: "nowrap", background: isRecording ? "linear-gradient(135deg, #ff6b6b, #ff4444)" : "transparent", color: isRecording ? "#fff" : "#6c63ff", border: isRecording ? "none" : "1px solid #6c63ff" }}
            onClick={toggleRecording} disabled={loading || dailyLimitReached}>
            {isMobile ? <Mic size={16} /> : (isRecording ? "Stop" : "Speak")}
          </button>

          {loading ? (
            <button
            style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--mcis-surface)", border: "1.5px solid var(--mcis-text)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0 }}
              onClick={handleStop}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="9" r="8" stroke="var(--mcis-text)" strokeWidth="1.5" />
                <rect x="6" y="6" width="6" height="6" rx="1" fill="var(--mcis-text)" />
              </svg>
            </button>
          ) : (
            <button
              style={{ borderRadius: 20, padding: "9px 16px", color: "#fff", fontWeight: "bold", fontSize: 13, border: "none", flexShrink: 0, whiteSpace: "nowrap", background: (dailyLimitReached || (!input.trim() && !uploadedFile && !uploadedImages.length)) ? "var(--mcis-disabled)" : "var(--mcis-primary)", cursor: (dailyLimitReached || (!input.trim() && !uploadedFile && !uploadedImages.length)) ? 'not-allowed' : 'pointer', boxShadow: (dailyLimitReached || (!input.trim() && !uploadedFile && !uploadedImages.length)) ? "none" : "var(--mcis-glow)" }}
              onClick={sendMessage} disabled={dailyLimitReached || (!input.trim() && !uploadedFile && !uploadedImages.length)}>
              <Send size={15} /> {!isMobile && 'Send'}
            </button>
          )}
        </div>
        {dailyLimitReached ? (
          <div className="mcis-composer-note" style={{ color: "var(--mcis-primary-solid)", fontWeight: 600 }}>
            You've used all {dailyLimitValue || 'your'} messages for today. Come back tomorrow, or upgrade for unlimited access.
          </div>
        ) : dailyRemaining !== null && dailyRemaining <= 20 ? (
          <div className="mcis-composer-note" style={{ color: "var(--mcis-primary-solid)" }}>
            {dailyRemaining} messages left today
          </div>
        ) : (
          <div className="mcis-composer-note">MCIS uses your saved context to make each conversation more useful.</div>
        )}
      </div>

      {/* ✅ CHANGED: key={user.uid} forces a clean remount of these panels per
          account, as an extra safety net on top of resetUserState() above */}
      {showMemory && <MemoryPanel key={user.uid} userId={user.uid} onClose={() => setShowMemory(false)} />}
      {showGoals && <GoalsPanel key={user.uid} userId={user.uid} onClose={() => setShowGoals(false)} />}
    </div>
    </>
  );
}

export default App;