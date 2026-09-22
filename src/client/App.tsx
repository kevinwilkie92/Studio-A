import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import { Spinner } from './components/ui'
import { useAuth } from './lib/auth'

import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'
import Book from './pages/Book'
import Appointments from './pages/Appointments'
import AppointmentDetail from './pages/AppointmentDetail'
import Account from './pages/Account'

import Dashboard from './pages/admin/Dashboard'
import Calendar from './pages/admin/Calendar'
import Clients from './pages/admin/Clients'
import ClientDetail from './pages/admin/ClientDetail'
import Texts from './pages/admin/Texts'
import Settings from './pages/admin/Settings'

/** Sends signed-out visitors to the login page, remembering where they were headed. */
function RequireAuth({ children, staffOnly = false }: { children: React.ReactNode; staffOnly?: boolean }) {
  const { user, loading, isStaff } = useAuth()
  const location = useLocation()

  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  if (staffOnly && !isStaff) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const { loading } = useAuth()

  return (
    <Layout>
      {loading ? (
        <Spinner />
      ) : (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route path="/book" element={<RequireAuth><Book /></RequireAuth>} />
          <Route path="/appointments" element={<RequireAuth><Appointments /></RequireAuth>} />
          <Route path="/appointments/:id" element={<RequireAuth><AppointmentDetail /></RequireAuth>} />
          <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />

          <Route path="/admin" element={<RequireAuth staffOnly><Dashboard /></RequireAuth>} />
          <Route path="/admin/calendar" element={<RequireAuth staffOnly><Calendar /></RequireAuth>} />
          <Route path="/admin/clients" element={<RequireAuth staffOnly><Clients /></RequireAuth>} />
          <Route path="/admin/clients/:id" element={<RequireAuth staffOnly><ClientDetail /></RequireAuth>} />
          <Route path="/admin/texts" element={<RequireAuth staffOnly><Texts /></RequireAuth>} />
          <Route path="/admin/settings" element={<RequireAuth staffOnly><Settings /></RequireAuth>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </Layout>
  )
}
