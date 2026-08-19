import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, lazy, Suspense } from 'react';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { t } from './i18n';
import { useAuthStore } from './store/auth';
import { useSettingsStore } from './store/settings';
import { useThemeStore } from './store/theme';
import { api } from './api/client';
import { applyThemeAccent, applyCustomCss } from './utils/theme';
import './styles/global.css';
import './styles/components.css';
import 'katex/dist/katex.min.css';

const ProblemList = lazy(() => import('./pages/ProblemList'));
const Home = lazy(() => import('./pages/Home'));
const ProblemDetail = lazy(() => import('./pages/ProblemDetail'));
const Submissions = lazy(() => import('./pages/Submissions'));
const SubmissionDetail = lazy(() => import('./pages/SubmissionDetail'));
const Rankings = lazy(() => import('./pages/Rankings'));
const Profile = lazy(() => import('./pages/Profile'));
const Favorites = lazy(() => import('./pages/Favorites'));
const Login = lazy(() => import('./pages/Login'));
const AuthCallback = lazy(() => import('./pages/AuthCallback'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const AdminCreateProblem = lazy(() => import('./pages/admin/AdminCreateProblem'));
const AdminProblems = lazy(() => import('./pages/admin/AdminProblems'));
const AdminTestcases = lazy(() => import('./pages/admin/AdminTestcases'));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'));
const AdminContests = lazy(() => import('./pages/admin/AdminContests'));
const AdminTickets = lazy(() => import('./pages/admin/AdminTickets'));
const AdminLists = lazy(() => import('./pages/admin/AdminLists'));
const AdminAnnouncement = lazy(() => import('./pages/admin/AdminAnnouncement'));
const AdminSettings = lazy(() => import('./pages/admin/AdminSettings'));
const AdminModels = lazy(() => import('./pages/admin/AdminModels'));
const AdminUploads = lazy(() => import('./pages/admin/AdminUploads'));
const AdminSql = lazy(() => import('./pages/admin/AdminSql'));
const AdminAuditLogs = lazy(() => import('./pages/admin/AdminAuditLogs'));
const AdminBans = lazy(() => import('./pages/admin/AdminBans'));
const NotFound = lazy(() => import('./pages/NotFound'));
const Contests = lazy(() => import('./pages/Contests'));
const ContestDetail = lazy(() => import('./pages/ContestDetail'));
const Tickets = lazy(() => import('./pages/Tickets'));
const CreateTicket = lazy(() => import('./pages/CreateTicket'));
const TicketDetail = lazy(() => import('./pages/TicketDetail'));
const ProblemLists = lazy(() => import('./pages/ProblemLists'));
const ProblemListDetail = lazy(() => import('./pages/ProblemListDetail'));
const CreateProblemList = lazy(() => import('./pages/CreateProblemList'));
const CreateContest = lazy(() => import('./pages/CreateContest'));
const Solutions = lazy(() => import('./pages/Solutions'));
const SolutionDetail = lazy(() => import('./pages/SolutionDetail'));
const Discussions = lazy(() => import('./pages/Discussions'));
const DiscussionDetail = lazy(() => import('./pages/DiscussionDetail'));
const GlobalSolutions = lazy(() => import('./pages/GlobalSolutions'));
const GlobalDiscussions = lazy(() => import('./pages/GlobalDiscussions'));
const MyFiles = lazy(() => import('./pages/MyFiles'));
const AIChat = lazy(() => import('./pages/AIChat'));
const Training = lazy(() => import('./pages/Training'));
const TrainingDetail = lazy(() => import('./pages/TrainingDetail'));
const AdminTraining = lazy(() => import('./pages/admin/AdminTraining'));
const AdminPlagiarism = lazy(() => import('./pages/admin/AdminPlagiarism'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Messages = lazy(() => import('./pages/Messages'));
const FollowList = lazy(() => import('./pages/FollowList'));
const Teams = lazy(() => import('./pages/Teams'));
const TeamDetail = lazy(() => import('./pages/TeamDetail'));
const CreateTeam = lazy(() => import('./pages/CreateTeam'));
const Blogs = lazy(() => import('./pages/Blogs'));
const BlogDetail = lazy(() => import('./pages/BlogDetail'));
const BlogEditor = lazy(() => import('./pages/BlogEditor'));
const AdminSolutionReview = lazy(() => import('./pages/admin/AdminSolutionReview'));
const AdminReports = lazy(() => import('./pages/admin/AdminReports'));
const AdminBlogs = lazy(() => import('./pages/admin/AdminBlogs'));
const AdminTeams = lazy(() => import('./pages/admin/AdminTeams'));
const AdminTags = lazy(() => import('./pages/admin/AdminTags'));
const AdminMessages = lazy(() => import('./pages/admin/AdminMessages'));
const AdminAds = lazy(() => import('./pages/admin/AdminAds'));
const AdminAnnouncements = lazy(() => import('./pages/admin/AdminAnnouncements'));
const AdminFriendLinks = lazy(() => import('./pages/admin/AdminFriendLinks'));
const AdminCustomPages = lazy(() => import('./pages/admin/AdminCustomPages'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Terms = lazy(() => import('./pages/Terms'));
const Contact = lazy(() => import('./pages/Contact'));
const UserSettings = lazy(() => import('./pages/UserSettings'));
const SubmissionCompare = lazy(() => import('./pages/SubmissionCompare'));
const Collections = lazy(() => import('./pages/Collections'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Templates = lazy(() => import('./pages/Templates'));
const Announcements = lazy(() => import('./pages/Announcements'));
const SearchPage = lazy(() => import('./pages/Search'));
const WrongProblems = lazy(() => import('./pages/WrongProblems'));
const ShareView = lazy(() => import('./pages/ShareView'));
const AnnualReport = lazy(() => import('./pages/AnnualReport'));
const CustomPage = lazy(() => import('./pages/CustomPage'));

function App() {
  const { fetchUser, token } = useAuthStore();

  useEffect(() => {
    if (token) {
      fetchUser();
    }
  }, [token, fetchUser]);

  // 主题定制:加载站点设置并应用管理端配置的主题色
  useEffect(() => {
    const applyTheme = async () => {
      const store = useSettingsStore.getState();
      if (!store.loaded) await store.fetchSettings();
      applyThemeAccent(useSettingsStore.getState().settings.theme_accent);
    };
    applyTheme();
  }, []);

  // 用户级主题:登录后从 user_settings 恢复用户保存的深浅主题与自定义 CSS
  useEffect(() => {
    if (!token) return;
    const applyServerTheme = async () => {
      try {
        const data = await api.getUserSettings();
        const t = data.settings?.theme;
        if (t === 'dark' || t === 'light') {
          useThemeStore.getState().applyServerTheme(t);
        }
        // 用户自定义主题 CSS
        const css = data.settings?.custom_css;
        if (typeof css === 'string') {
          applyCustomCss(css);
        }
      } catch {
        // ignore
      }
    };
    applyServerTheme();
  }, [token]);

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Layout>
          <Suspense fallback={<div className="loading-container"><div className="loading-spinner"></div><p>{t('common.loading')}</p></div>}>
            <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/problems" element={<ProblemList />} />
            <Route path="/problems/:slug" element={<ProblemDetail />} />
            <Route path="/submissions" element={<Submissions />} />
            <Route path="/submissions/:id" element={<SubmissionDetail />} />
            <Route path="/submissions/compare/:id1/:id2" element={<SubmissionCompare />} />
            <Route path="/rankings" element={<Rankings />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/users/:username" element={<Profile />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<AdminDashboard />} />
              <Route path="create-problem" element={<AdminCreateProblem />} />
              <Route path="problems" element={<AdminProblems />} />
              <Route path="testcases" element={<AdminTestcases />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="contests" element={<AdminContests />} />
              <Route path="tickets" element={<AdminTickets />} />
              <Route path="lists" element={<AdminLists />} />
              <Route path="announcement" element={<AdminAnnouncement />} />
              <Route path="announcements" element={<AdminAnnouncements />} />
              <Route path="friend-links" element={<AdminFriendLinks />} />
              <Route path="custom-pages" element={<AdminCustomPages />} />
              <Route path="settings" element={<AdminSettings />} />
              <Route path="models" element={<AdminModels />} />
              <Route path="uploads" element={<AdminUploads />} />
              <Route path="sql" element={<AdminSql />} />
              <Route path="audit-logs" element={<AdminAuditLogs />} />
              <Route path="bans" element={<AdminBans />} />
              <Route path="training" element={<AdminTraining />} />
              <Route path="plagiarism" element={<AdminPlagiarism />} />
              <Route path="solution-review" element={<AdminSolutionReview />} />
              <Route path="reports" element={<AdminReports />} />
              <Route path="blogs" element={<AdminBlogs />} />
              <Route path="teams" element={<AdminTeams />} />
              <Route path="tags" element={<AdminTags />} />
              <Route path="messages" element={<AdminMessages />} />
              <Route path="ads" element={<AdminAds />} />
            </Route>
            <Route path="/matches" element={<Contests />} />
            <Route path="/match/new" element={<CreateContest />} />
            <Route path="/match/:id/edit" element={<CreateContest />} />
            <Route path="/match/:id" element={<ContestDetail />} />
            <Route path="/match/:id/problem/:problemId" element={<ProblemDetail />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/tickets/new" element={<CreateTicket />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/lists" element={<ProblemLists />} />
            <Route path="/lists/new" element={<CreateProblemList />} />
            <Route path="/lists/:id" element={<ProblemListDetail />} />
            <Route path="/solutions/all" element={<GlobalSolutions />} />
            <Route path="/solutions/:id" element={<SolutionDetail />} />
            <Route path="/solutions" element={<Solutions />} />
            <Route path="/discussions/all" element={<GlobalDiscussions />} />
            <Route path="/discussions/:id" element={<DiscussionDetail />} />
            <Route path="/discussions" element={<Discussions />} />
            <Route path="/my-files" element={<MyFiles />} />
            <Route path="/ai" element={<AIChat />} />
            <Route path="/training" element={<Training />} />
            <Route path="/training/:id" element={<TrainingDetail />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/messages/:id" element={<Messages />} />
            <Route path="/users/:username/followers" element={<FollowList />} />
            <Route path="/users/:username/following" element={<FollowList />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/teams/new" element={<CreateTeam />} />
            <Route path="/team/:teamId" element={<TeamDetail />} />
            <Route path="/team/:teamId/problem/:problemId" element={<ProblemDetail />} />
            <Route path="/team/:teamId/match/:matchId" element={<ContestDetail />} />
            <Route path="/team/:teamId/match/:matchId/problem/:problemId" element={<ProblemDetail />} />
            <Route path="/blogs" element={<Blogs />} />
            <Route path="/blogs/:id" element={<BlogDetail />} />
            <Route path="/blog/write" element={<BlogEditor />} />
            <Route path="/blog/:id/edit" element={<BlogEditor />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/settings" element={<UserSettings />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/collections/:id" element={<Collections />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/announcements" element={<Announcements />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/wrong-problems" element={<WrongProblems />} />
            <Route path="/shares/:token" element={<ShareView />} />
            <Route path="/annual-report" element={<AnnualReport />} />
            <Route path="/page/:slug" element={<CustomPage />} />
            <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </Layout>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
