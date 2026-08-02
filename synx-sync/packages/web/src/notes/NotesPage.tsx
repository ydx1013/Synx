import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { ArrowLeft, BookOpen, ChevronRight, Clock3, Edit3, FileText, Folder, History, LogOut, Menu, MoreHorizontal, Plus, Save, Search, Settings, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { FileMeta, VersionRecord } from '@synx/shared';
import { authApi, notesApi } from '../api/queries';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Dialog } from '../components/Dialog';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists, { enabled: true, label: true });
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
const encode = (value: string) => { const bytes = new TextEncoder().encode(value); let binary = ''; bytes.forEach(byte => binary += String.fromCharCode(byte)); return btoa(binary); };
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const displayName = (path: string) => path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? path;
const formatSize = (size: number) => size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

export function NotesPage() {
  const client = use