// components/chat-rooms.tsx

"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Users,
  WifiOff,
  ServerCrash,
  PlusCircle,
  X,
  Sparkles,
  Search,
} from "lucide-react";
import { motion, AnimatePresence, Variants } from "framer-motion";
import GroupChat from "@/src/components/group-chat/group-chat";
import { ChatThemeProvider } from "@/src/context/theme-context";

// --- START: In-component LoadingSpinner ---
const LoadingSpinner = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`animate-spin ${className}`}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);
// --- END: In-component LoadingSpinner ---

// --- TYPE DEFINITIONS ---
interface ChatServer {
  timestamp: number;
  url: string;
  version: string;
  status: string;
  serviceName: string;
}

export interface ChatRoom {
  id: string;
  participants: string[];
  max_participants: number;
  name: string;
  serverUrl: string;
}

// --- CONSTANTS ---
const DISCOVERY_SERVICE_URL =
  "https://animochat-service-discovery.onrender.com/discover/chat-service/1.0.0/all";

// --- START: REFACTORED AND NEW SUB-COMPONENTS ---

// Enhanced Modal with the green and white aesthetic
const CreateRoomModal = ({
  isOpen,
  onClose,
  onSubmit,
  isCreating,
  error,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string, maxParticipants: number) => void;
  isCreating: boolean;
  error: string | null;
}) => {
  const [name, setName] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("10");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const maxP = parseInt(maxParticipants, 10);
    if (name.trim() && !isNaN(maxP) && maxP > 1) {
      onSubmit(name.trim(), maxP);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 30, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 30, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="bg-white/80 backdrop-blur-lg border border-gray-200/50 rounded-2xl shadow-2xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 sm:p-8">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="text-green-500" />
                  Create a New Room
                </h2>
                <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full text-gray-500 hover:bg-gray-500/10">
                  <X size={20} />
                </Button>
              </div>
              <form onSubmit={handleSubmit} className="space-y-6">
                <Input
                  placeholder="Room Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="py-6 px-4 bg-white/50 border-gray-300 rounded-lg focus:ring-green-500"
                  required
                  maxLength={50}
                />
                <Input
                  type="number"
                  placeholder="Max Participants"
                  value={maxParticipants}
                  onChange={(e) => setMaxParticipants(e.target.value)}
                  className="py-6 px-4 bg-white/50 border-gray-300 rounded-lg focus:ring-green-500"
                  required
                  min="2"
                  max="100"
                />
                {error && <p className="text-red-500 text-sm">{error}</p>}
                <Button type="submit" className="w-full py-6 bg-green-600 hover:bg-green-700 font-bold text-base text-white rounded-lg transition-all duration-300 shadow-lg hover:shadow-green-500/30" disabled={isCreating}>
                  {isCreating ? <LoadingSpinner /> : "Create Room"}
                </Button>
              </form>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// RoomCard component with green accents
const RoomCard = ({ room, onJoin }: { room: ChatRoom; onJoin: () => void }) => {
  return (
    <motion.div
        layout
        variants={{
            hidden: { y: 30, opacity: 0, scale: 0.95 },
            visible: { y: 0, opacity: 1, scale: 1, transition: { type: "spring", stiffness: 250, damping: 35 } },
            exit: { y: -30, opacity: 0, scale: 0.95 }
        }}
        whileHover={{ scale: 1.03, y: -5 }}
        className="bg-white/60 backdrop-blur-md rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300 overflow-hidden cursor-pointer flex flex-col border border-gray-200/30"
        onClick={onJoin}
      >
        <div className="bg-green-500 h-2 w-full" />
        <div className="p-6 flex-grow flex flex-col justify-between">
          <div>
            <h3 className="text-xl font-bold text-gray-900 truncate mb-2">{room.name}</h3>
            <div className="flex items-center text-gray-600 text-sm">
                <Users size={16} className="mr-2 flex-shrink-0" />
                <span className="font-medium">{room.participants.length} / {room.max_participants}</span>
                 <span className="mx-2">·</span>
                <span className="text-gray-500">{room.participants.length < room.max_participants * 0.5 ? "Quiet" : room.participants.length < room.max_participants * 0.8 ? "Active" : "Popular"}</span>
            </div>
          </div>
          <div className="mt-6">
              <div className="flex items-center justify-end text-sm font-semibold text-green-600">
                Join Room
                <motion.span initial={{x:0}} whileHover={{x:4}} className="ml-1 transition-transform">
                    →
                </motion.span>
              </div>
          </div>
        </div>
      </motion.div>
  );
};

// FeedbackState component
const FeedbackState = ({
  icon: Icon,
  title,
  message,
}: {
  icon: React.ElementType;
  title: string;
  message: string;
}) => (
  <div className="flex flex-col items-center justify-center text-center text-gray-500 bg-white/30 p-12 rounded-2xl backdrop-blur-sm">
    <Icon size={48} className="mb-4 text-gray-400" />
    <h3 className="text-xl font-bold text-gray-800">{title}</h3>
    <p className="text-sm mt-2 max-w-sm">{message}</p>
  </div>
);


// --- MAIN COMPONENT ---
export default function ChatRooms() {
  const [chatServers, setChatServers] = useState<ChatServer[]>([]);
  const [allChatRooms, setAllChatRooms] = useState<ChatRoom[]>([]);
  const [filteredChatRooms, setFilteredChatRooms] = useState<ChatRoom[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoom | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [createRoomError, setCreateRoomError] = useState<string | null>(null);

  const fetchChatRooms = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const serverResponse = await fetch(DISCOVERY_SERVICE_URL);
      if (!serverResponse.ok) throw new Error(`Discovery service failed (Status: ${serverResponse.status})`);
      const servers: ChatServer[] = await serverResponse.json();
      const runningServers = servers.filter((s) => s.status === "RUNNING");
      setChatServers(runningServers);

      if (runningServers.length === 0) throw new Error("No active chat servers found to host rooms.");

      const roomPromises = runningServers.map(async (server) => {
        try {
          const roomsResponse = await fetch(`${server.url}/rooms`);
          if (!roomsResponse.ok) return [];
          const roomsData = await roomsResponse.json();
          return roomsData.map((room: Omit<ChatRoom, "serverUrl">) => ({ ...room, serverUrl: server.url }));
        } catch { return []; }
      });
      const results = await Promise.all(roomPromises);
      const allRooms = results.flat();
      setAllChatRooms(allRooms);
      setFilteredChatRooms(allRooms);
    } catch (e) {
      if (e instanceof Error) setError(e.message);
      else setError("An unknown error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchChatRooms();
  }, []);

  useEffect(() => {
    const handler = setTimeout(() => {
        const filtered = allChatRooms.filter(room => room.name.toLowerCase().includes(searchQuery.toLowerCase()));
        setFilteredChatRooms(filtered);
    }, 200);
    return () => clearTimeout(handler);
  }, [searchQuery, allChatRooms]);

  const handleCreateRoom = async (name: string, maxParticipants: number) => {
    setIsCreatingRoom(true);
    setCreateRoomError(null);
    const server = chatServers[0];
    if (!server) {
      setCreateRoomError("No available chat server.");
      setIsCreatingRoom(false);
      return;
    }
    try {
      const response = await fetch(`${server.url}/create-room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, maxParticipants }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create room.");
      }
      setIsModalOpen(false);
      // Reset form state is handled inside the modal now
      await fetchChatRooms();
    } catch (e) {
      if (e instanceof Error) setCreateRoomError(e.message);
      else setCreateRoomError("An unexpected error occurred.");
    } finally {
      setIsCreatingRoom(false);
    }
  };


  const renderRoomList = () => {
    if (isLoading) {
      return (
          <div className="flex items-center justify-center pt-20">
              <LoadingSpinner className="text-green-500" />
          </div>
      );
    }

    if (error) {
      return <FeedbackState icon={ServerCrash} title="Could Not Load Rooms" message={error} />;
    }

    if (allChatRooms.length === 0) {
      return <FeedbackState icon={WifiOff} title="No Rooms Available" message="There are currently no public chat rooms. Why not start one?" />;
    }
    
    if (filteredChatRooms.length === 0 && searchQuery) {
        return <FeedbackState icon={Search} title="No Rooms Found" message={`Your search for "${searchQuery}" did not match any rooms.`} />;
    }

    return (
      <AnimatePresence>
        <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={{
                visible: { transition: { staggerChildren: 0.07 } }
            }}
        >
          {filteredChatRooms.map((room) => (
            <RoomCard key={room.id} room={room} onJoin={() => setSelectedRoom(room)} />
          ))}
        </motion.div>
      </AnimatePresence>
    );
  };
  
  if (selectedRoom) {
      return (
          <div className="w-full h-full">
              <ChatThemeProvider>
                  <GroupChat room={selectedRoom} onLeave={() => setSelectedRoom(null)} />
              </ChatThemeProvider>
          </div>
      );
  }

  return (
    <>
      <CreateRoomModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onSubmit={handleCreateRoom} isCreating={isCreatingRoom} error={createRoomError} />
      
      {/* Background */}
      <div className="fixed inset-0 -z-10 h-full w-full bg-white">
        <div className="fixed inset-0 -z-10 h-full w-full bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:14px_24px]"></div>
        <div className="fixed bottom-0 left-0 right-0 top-0 bg-[radial-gradient(circle_500px_at_50%_200px,#10b98122,transparent)]"></div>
      </div>
      
      <div className="min-h-screen p-4 sm:p-6 lg:p-8">
        <div className="max-w-screen-xl mx-auto">
          {/* Header */}
          <header className="sticky top-6 z-40 bg-white/70 backdrop-blur-lg p-4 rounded-2xl shadow-lg shadow-gray-500/5 border border-gray-200/50 mb-8">
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <h1 className="text-3xl font-bold text-gray-800">
                    Public Chat Rooms
                </h1>
                <div className="flex items-center gap-2 sm:gap-4">
                    <div className="relative">
                        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
                        <Input 
                            placeholder="Search rooms..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-9 pr-3 py-2 h-10 w-40 sm:w-56 rounded-full bg-gray-500/10 border-transparent focus:bg-white focus:ring-2 focus:ring-green-500"
                        />
                    </div>
                    {/* <Button onClick={() => setIsModalOpen(true)} className="bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full shadow-lg hover:shadow-green-500/30 transition-all duration-300">
                        <PlusCircle size={20} className="mr-0 sm:mr-2" />
                        <span className="hidden sm:inline">Create</span>
                    </Button> */}
                </div>
            </div>
          </header>

          <main>{renderRoomList()}</main>
        </div>
      </div>
    </>
  );
}